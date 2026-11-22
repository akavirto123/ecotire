import type { HeatCell } from '@/lib/db';
import type { RiskZone } from '@/lib/risk';

/**
 * Mapa de calor de EXEMPLO: simula o que ~500 motoristas gerariam na área visível,
 * para testar e apresentar antes de haver muitos usuários. Sempre exibido como simulação.
 *
 * Regra do exemplo: freadas e retomadas se concentram perto de escolas, hospitais e
 * trechos ruins (zonas de risco) e ao longo da rota planejada; o resto é ruído leve.
 * Os pontos são fixos para cada lugar (semente pelo id), então não "pulam" ao mover o mapa.
 */
type Bounds = { south: number; west: number; north: number; east: number };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Ponto aleatório com distribuição normal em volta de (lat, lng), desvio em metros. */
function around(r: () => number, lat: number, lng: number, sdM: number) {
  const u = Math.max(1e-9, r());
  const v = r();
  const mag = Math.sqrt(-2 * Math.log(u)) * sdM;
  const dy = mag * Math.cos(2 * Math.PI * v);
  const dx = mag * Math.sin(2 * Math.PI * v);
  return { lat: lat + dy / 111_320, lng: lng + dx / (111_320 * Math.cos((lat * Math.PI) / 180)) };
}

const WEIGHT: Record<string, number> = { school: 9, hospital: 7, pavement: 8, works: 6, other: 5 };

export function simulateHeat(b: Bounds, zones: RiskZone[], route?: { lat: number; lng: number }[] | null): HeatCell[] {
  const inside = (p: { lat: number; lng: number }) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
  const out: HeatCell[] = [];

  const visible = zones.filter(inside).slice(0, 180);
  for (const z of visible) {
    const r = rng(hash(z.id));
    const n = 6 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) {
      const p = around(r, z.lat, z.lng, 70 + r() * 90);
      out.push({ ...p, mg: (WEIGHT[z.type] ?? 5) * (0.4 + r() * 0.9) });
    }
  }

  if (route?.length) {
    const step = Math.max(1, Math.floor(route.length / 160));
    for (let i = 0; i < route.length; i += step) {
      const { lat, lng } = route[i]!;
      const r = rng(hash(`${lat.toFixed(4)},${lng.toFixed(4)}`));
      const p = around(r, lat, lng, 25);
      if (inside(p)) out.push({ ...p, mg: 1.5 + r() * 4 });
    }
  }

  // ruído de fundo: alguns focos espalhados, presos a uma grade de ~1 km para não mudar a cada movimento
  const G = 0.01;
  let added = 0;
  for (let y = Math.floor(b.south / G); y <= Math.floor(b.north / G) && added < 400; y++) {
    for (let x = Math.floor(b.west / G); x <= Math.floor(b.east / G) && added < 400; x++) {
      const r = rng(hash(`${y}:${x}`));
      if (r() > 0.35) continue;
      const c = around(r, (y + 0.5) * G, (x + 0.5) * G, 300);
      for (let k = 0; k < 4; k++) {
        const p = around(r, c.lat, c.lng, 120);
        if (inside(p)) {
          out.push({ ...p, mg: 1 + r() * 3 });
          added++;
        }
      }
    }
  }

  // sem zonas na tela (ex.: zoom muito aberto): alguns focos para a demonstração não ficar vazia
  if (!visible.length) {
    const r = rng(hash(`${b.south.toFixed(2)}:${b.west.toFixed(2)}`));
    for (let h = 0; h < 10; h++) {
      const c = { lat: b.south + r() * (b.north - b.south), lng: b.west + r() * (b.east - b.west) };
      for (let k = 0; k < 14; k++) out.push({ ...around(r, c.lat, c.lng, 250), mg: 3 + r() * 8 });
    }
  }
  return out;
}
