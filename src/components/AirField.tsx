import { useEffect, useRef } from 'react';

/**
 * Fundo da tela de entrada: uma estrada em perspectiva soltando poeira de pneu.
 * A poeira reage ao ponteiro (o "vento" da mão espalha as partículas).
 */
export function AirField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-eco').trim() || '#ff6a1a';
    const N = reduce ? 160 : 900;
    const x = new Float32Array(N), y = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
    const life = new Float32Array(N), span = new Float32Array(N), sz = new Float32Array(N), hot = new Uint8Array(N);
    let w = 0, h = 0, dpr = 1;
    const pointer = { x: -9999, y: -9999, vx: 0, vy: 0 };
    // sprites pré-desenhados: um gradiente por cor, não um por partícula
    const sprite = (c: string) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d')!;
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, c);
      gr.addColorStop(1, 'transparent');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      return cv;
    };
    const dustSprite = sprite('#d6cdc4');
    const hotSprite = sprite(accent);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // estrada: curva de baixo (perto) até o horizonte (longe)
    const road = (t: number) => {
      const yy = h * (0.98 - t * 0.5);
      const xx = w * (0.5 + Math.sin(t * 2.4 + 0.6) * 0.14 * (1 - t * 0.6));
      return { x: xx, y: yy, scale: 1 - t * 0.82 };
    };
    const spawn = (i: number) => {
      const t = Math.random() ** 1.6;
      const p = road(t);
      const side = Math.random() < 0.5 ? -1 : 1;
      x[i] = p.x + side * 60 * p.scale + (Math.random() - 0.5) * 20 * p.scale;
      y[i] = p.y;
      vx[i] = (Math.random() - 0.3) * 18 * p.scale;
      vy[i] = -(10 + Math.random() * 30) * p.scale;
      life[i] = 0;
      span[i] = 2.5 + Math.random() * 4;
      sz[i] = (2 + Math.random() * 7) * p.scale + 1;
      hot[i] = Math.random() < 0.18 ? 1 : 0;
    };
    for (let i = 0; i < N; i++) {
      spawn(i);
      life[i] = Math.random() * span[i];
    }

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const nx = e.clientX - r.left, ny = e.clientY - r.top;
      pointer.vx = nx - pointer.x;
      pointer.vy = ny - pointer.y;
      pointer.x = nx;
      pointer.y = ny;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // faixas da estrada
      ctx.globalCompositeOperation = 'source-over';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        for (let k = 0; k <= 40; k++) {
          const p = road(k / 40);
          const px = p.x + side * 70 * p.scale;
          if (k === 0) ctx.moveTo(px, p.y);
          else ctx.lineTo(px, p.y);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.setLineDash([14, 18]);
      ctx.lineDashOffset = -(now / 40) % 32;
      ctx.beginPath();
      for (let k = 0; k <= 40; k++) {
        const p = road(k / 40);
        if (k === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        life[i] += dt;
        if (life[i] >= span[i]) spawn(i);
        const dx = x[i] - pointer.x, dy = y[i] - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 140 * 140) {
          const f = (1 - Math.sqrt(d2) / 140) * 6;
          vx[i] += (dx * 0.02 + pointer.vx * 0.15) * f * dt * 10;
          vy[i] += (dy * 0.02 + pointer.vy * 0.15) * f * dt * 10;
        }
        vx[i] *= 0.985;
        vy[i] = vy[i] * 0.985 - 4 * dt;
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        const t = life[i] / span[i];
        const a = Math.min(1, life[i] * 3) * (1 - t) * (hot[i] ? 0.55 : 0.28);
        const r = sz[i] * (1 + t * 2.2);
        ctx.globalAlpha = a;
        ctx.drawImage(hot[i] ? hotSprite : dustSprite, x[i] - r, y[i] - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      pointer.vx *= 0.8;
      pointer.vy *= 0.8;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
