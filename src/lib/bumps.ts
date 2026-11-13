/**
 * Detecção automática de buracos pelo acelerômetro do celular.
 * Protótipo da ideia de patente: no carro, a mesma lógica usaria a suspensão e as câmeras do veículo.
 *
 * Como funciona: acompanha a aceleração total (com gravidade) e uma linha de base lenta.
 * Um buraco aparece como um pico curto e forte, bem acima da vibração normal da via.
 */

export type Bump = { at: number; strengthG: number };

export type BumpOptions = {
  /** desvio mínimo em relação à linha de base, em m/s² (≈ 0,55 g) */
  thresholdMs2?: number;
  /** tempo mínimo entre dois buracos, em ms */
  refractoryMs?: number;
  /** abaixo desta velocidade, ignora (lombadas e manobras lentas) */
  minSpeedKmh?: number;
};

const G = 9.81;

export class BumpDetector {
  private baseline = G;
  private warm = 0;
  private lastBump = -Infinity;
  private readonly threshold: number;
  private readonly refractory: number;
  private readonly minSpeed: number;

  constructor(opts: BumpOptions = {}) {
    this.threshold = opts.thresholdMs2 ?? 5.4;
    this.refractory = opts.refractoryMs ?? 3000;
    this.minSpeed = opts.minSpeedKmh ?? 12;
  }

  /** Recebe uma amostra (aceleração com gravidade, m/s²) e devolve um buraco quando detectar. */
  push(ax: number, ay: number, az: number, t: number, speedKmh: number): Bump | null {
    const mag = Math.hypot(ax, ay, az);
    if (!Number.isFinite(mag)) return null;
    const dev = Math.abs(mag - this.baseline);
    // linha de base lenta: absorve inclinação do celular e a vibração constante do asfalto
    this.baseline += (mag - this.baseline) * 0.04;
    this.warm++;
    if (this.warm < 25) return null;
    if (speedKmh < this.minSpeed) return null;
    if (dev < this.threshold) return null;
    if (t - this.lastBump < this.refractory) return null;
    this.lastBump = t;
    return { at: t, strengthG: dev / G };
  }
}

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export function motionSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

/** No iPhone o acesso ao sensor precisa ser pedido a partir de um toque do usuário. */
export async function requestMotionPermission(): Promise<boolean> {
  if (!motionSupported()) return false;
  const DM = window.DeviceMotionEvent as unknown as MotionPermission;
  if (typeof DM.requestPermission !== 'function') return true;
  try {
    return (await DM.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Liga o sensor. Devolve uma função para desligar. */
export function startBumpSensor(getSpeedKmh: () => number, onBump: (b: Bump) => void, opts?: BumpOptions): () => void {
  if (!motionSupported()) return () => undefined;
  const det = new BumpDetector(opts);
  const handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const b = det.push(a.x, a.y, a.z, performance.now(), getSpeedKmh());
    if (b) onBump(b);
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
