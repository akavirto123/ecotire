import type { Map as MlMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';

/**
 * "Ar visível": desenha sobre o mapa 3D a poeira estimada que o pneu solta.
 * Cada emissor é um ponto no mundo (lng/lat) que solta partículas numa taxa proporcional ao PM2.5
 * estimado ali. As partículas sobem, são levadas por um vento leve e somem. A projeção usa o próprio
 * mapa, então a nuvem acompanha zoom, inclinação e rotação.
 */
export type AirTone = 'dust' | 'low' | 'moderate' | 'high';
export type AirEmitter = { lng: number; lat: number; rate: number; tone: AirTone; spread?: number };

const TONES: Record<AirTone, [number, number, number]> = {
  dust: [214, 205, 196],
  low: [52, 211, 153],
  moderate: [251, 191, 36],
  high: [251, 113, 133],
};
const TONE_IDX: AirTone[] = ['dust', 'low', 'moderate', 'high'];
const MAX = 1800;

function sprite(rgb: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb.join(',')},0.9)`);
  grad.addColorStop(0.4, `rgba(${rgb.join(',')},0.35)`);
  grad.addColorStop(1, `rgba(${rgb.join(',')},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

export function AirOverlay({ map, emitters }: { map: MlMap | null; emitters: AirEmitter[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const src = useRef(emitters);
  src.current = emitters;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sprites = TONE_IDX.map((t) => sprite(TONES[t]));

    const lng = new Float64Array(MAX);
    const lat = new Float64Array(MAX);
    const alt = new Float32Array(MAX);
    const vx = new Float32Array(MAX);
    const vy = new Float32Array(MAX);
    const vz = new Float32Array(MAX);
    const life = new Float32Array(MAX);
    const span = new Float32Array(MAX);
    const size = new Float32Array(MAX);
    const tone = new Uint8Array(MAX);
    let head = 0;
    let debts: number[] = [];

    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, canvas.clientWidth * dpr);
      canvas.height = Math.max(1, canvas.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // vento lento que muda de direção aos poucos
    let windA = Math.random() * Math.PI * 2;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      windA += (Math.random() - 0.5) * 0.02;
      const wx = Math.cos(windA) * 1.4;
      const wy = Math.sin(windA) * 1.4;

      const em = src.current;
      if (debts.length !== em.length) debts = new Array(em.length).fill(0);
      const k = reduce ? 0.15 : 1;
      for (let e = 0; e < em.length; e++) {
        debts[e] += em[e].rate * k * dt;
        while (debts[e] >= 1) {
          debts[e] -= 1;
          const i = head;
          head = (head + 1) % MAX;
          const s = em[e].spread ?? 8;
          const cosLat = Math.cos((em[e].lat * Math.PI) / 180);
          lng[i] = em[e].lng + ((Math.random() - 0.5) * 2 * s) / (111320 * cosLat);
          lat[i] = em[e].lat + ((Math.random() - 0.5) * 2 * s) / 111320;
          alt[i] = Math.random() * 1.5;
          vx[i] = wx + (Math.random() - 0.5) * 1.6;
          vy[i] = wy + (Math.random() - 0.5) * 1.6;
          vz[i] = 1.2 + Math.random() * 2.2;
          life[i] = 0;
          span[i] = 3 + Math.random() * 5;
          size[i] = 7 + Math.random() * 10; // metros
          tone[i] = TONE_IDX.indexOf(em[e].tone);
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      const zoom = map.getZoom();
      const sinPitch = Math.sin((map.getPitch() * Math.PI) / 180);
      const center = map.getCenter();
      const mpp = (156543.03 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom; // metros por pixel CSS
      const w = canvas.width;
      const h = canvas.height;

      for (let i = 0; i < MAX; i++) {
        if (span[i] === 0) continue;
        life[i] += dt;
        if (life[i] >= span[i]) {
          span[i] = 0;
          continue;
        }
        const cosLat = Math.cos((lat[i] * Math.PI) / 180);
        lng[i] += (vx[i] * dt) / (111320 * cosLat);
        lat[i] += (vy[i] * dt) / 111320;
        alt[i] += vz[i] * dt;
        vz[i] *= 0.992;
        const p = map.project([lng[i], lat[i]]);
        const x = p.x * dpr;
        const y = (p.y - (alt[i] / mpp) * sinPitch) * dpr;
        if (x < -60 || y < -60 || x > w + 60 || y > h + 60) continue;
        const t = life[i] / span[i];
        const fadeIn = Math.min(1, life[i] * 2.5);
        ctx.globalAlpha = 0.6 * fadeIn * (1 - t) * (1 - t);
        const r = Math.min(60, Math.max(4, (size[i] + life[i] * 6) / mpp)) * dpr;
        ctx.drawImage(sprites[tone[i]], x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [map]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}
