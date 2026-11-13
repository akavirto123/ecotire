/**
 * IA local do EcoTire: aprendizado de máquina que roda inteiro no navegador.
 * Não chama nenhum serviço pago nem envia dados para fora: custo zero para quem usa.
 *
 * O modelo aprende o "fator pessoal" do motorista: quantas vezes ele emite em relação a uma
 * condução perfeitamente suave, em função da velocidade média da viagem. É uma regressão linear
 * com regularização (ridge) puxada para um valor inicial, então funciona desde a primeira viagem
 * e fica mais pessoal a cada viagem registrada.
 */
import { accelFactor, basePm25PerKm, speedFactor } from '@/lib/emissions';
import type { Trip } from '@/lib/supabase';

export type DriverModel = {
  /** fator = w0 + w1 × (velocidade média − 40) / 20 */
  w0: number;
  w1: number;
  /** viagens usadas no treino */
  n: number;
  /** erro médio absoluto do fator nas viagens de treino */
  mae: number;
};

/** Ponto de partida antes de haver dados: condução com 30% de agressividade. */
const PRIOR = { w0: accelFactor(0.18), w1: 0 };
const LAMBDA = 2; // força do ponto de partida (equivale a ~2 viagens)
const feature = (avgSpeedKmh: number) => (avgSpeedKmh - 40) / 20;

/** Fator observado numa viagem: emissão real ÷ emissão de uma condução suave no mesmo trajeto. */
export function observedFactor(t: Trip): number | null {
  const km = Number(t.distance_km);
  const pm = Number(t.pm25_emitted_mg);
  if (t.mode === 'plan' || t.mode === 'passenger' || !(km >= 0.3) || !(pm > 0)) return null;
  const smooth = basePm25PerKm(Number(t.gross_weight_kg) || 1500) * speedFactor(Number(t.avg_speed_kmh)) * km;
  return smooth > 0 ? pm / smooth : null;
}

export function trainDriverModel(trips: Trip[]): DriverModel {
  const rows = trips.flatMap((t) => {
    const y = observedFactor(t);
    return y == null ? [] : [{ x: feature(Number(t.avg_speed_kmh)), y }];
  });
  // equações normais 2×2 com regularização: (XᵀX + λI) w = Xᵀy + λ·prior
  let a = LAMBDA, b = 0, d = LAMBDA, e = LAMBDA * PRIOR.w0, f = LAMBDA * PRIOR.w1;
  for (const { x, y } of rows) {
    a += 1;
    b += x;
    d += x * x;
    e += y;
    f += x * y;
  }
  const det = a * d - b * b;
  const w0 = (e * d - b * f) / det;
  const w1 = (a * f - b * e) / det;
  const mae = rows.length ? rows.reduce((s, r) => s + Math.abs(w0 + w1 * r.x - r.y), 0) / rows.length : 0;
  return { w0, w1, n: rows.length, mae };
}

export function predictFactor(m: DriverModel, avgSpeedKmh: number): number {
  return Math.max(1, Math.min(3.2, m.w0 + m.w1 * feature(avgSpeedKmh)));
}

/** PM2.5 previsto para ESTE motorista numa rota (effKm já inclui o acréscimo de piso irregular). */
export function predictPm25(m: DriverModel, grossKg: number, avgSpeedKmh: number, effKm: number): number {
  return basePm25PerKm(grossKg) * speedFactor(avgSpeedKmh) * predictFactor(m, avgSpeedKmh) * effKm;
}

/** Frase curta explicando o que o modelo aprendeu. */
export function describeModel(m: DriverModel): string {
  if (m.n === 0) return 'Ainda sem viagens: a previsão usa um motorista médio. A partir da primeira viagem ela passa a aprender o seu estilo.';
  const city = predictFactor(m, 35);
  const pct = Math.round((city - 1) * 100);
  const trend = m.w1 > 0.06 ? ' Você tende a emitir mais em trajetos rápidos.' : m.w1 < -0.06 ? ' Você tende a emitir mais em trajetos lentos, de anda e para.' : '';
  return `Aprendido com ${m.n} ${m.n === 1 ? 'viagem' : 'viagens'}: no trânsito urbano você emite cerca de ${pct}% acima de uma condução perfeitamente suave.${trend}`;
}
