import { useEffect, useRef, useState } from 'react';

const LOW = [52, 211, 153];
const MID = [251, 191, 36];
const HIGH = [251, 113, 133];
const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * t)).join(',')})`;
export const intensityColor = (k: number) => (k < 0.5 ? mix(LOW, MID, k * 2) : mix(MID, HIGH, (k - 0.5) * 2));

const R = 52;
const SWEEP = 270;
const arcPath = (frac: number) => {
  const a0 = (135 * Math.PI) / 180;
  const a1 = a0 + (SWEEP * Math.PI * Math.max(0.001, Math.min(1, frac))) / 180;
  const p = (a: number) => `${(64 + R * Math.cos(a)).toFixed(2)} ${(64 + R * Math.sin(a)).toFixed(2)}`;
  return `M ${p(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
};

/**
 * Medidor da viagem: arco com a emissão de agora e, embaixo, o histórico dos últimos segundos.
 * Substitui o pneu 3D durante a viagem: mostra o que importa sem distrair.
 */
export function LiveGauge({ intensity, tick, label, className = '' }: { intensity: number; tick: number; label: string; className?: string }) {
  const k = Math.max(0, Math.min(1, intensity));
  const [smooth, setSmooth] = useState(k);
  const hist = useRef<number[]>([]);
  const [, force] = useState(0);

  // arco anda suave até o valor novo
  useEffect(() => {
    let raf = 0;
    const step = () => {
      setSmooth((s) => {
        const n = s + (k - s) * 0.18;
        if (Math.abs(n - k) > 0.004) raf = requestAnimationFrame(step);
        return n;
      });
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [k]);

  useEffect(() => {
    hist.current = [...hist.current.slice(-35), k];
    force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const color = intensityColor(smooth);
  const bars = hist.current;
  return (
    <div className={`flex flex-col items-center ${className}`}>
      <svg viewBox="0 0 128 110" className="h-28 w-full max-w-[150px]" role="img" aria-label={`Emissão agora: ${label}`}>
        <defs>
          <filter id="gauge-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.5" />
          </filter>
        </defs>
        <path d={arcPath(1)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
        {/* marcas do mostrador */}
        {Array.from({ length: 10 }, (_, i) => {
          const a = ((135 + (SWEEP * i) / 9) * Math.PI) / 180;
          return <line key={i} x1={64 + 40 * Math.cos(a)} y1={64 + 40 * Math.sin(a)} x2={64 + 44 * Math.cos(a)} y2={64 + 44 * Math.sin(a)} stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />;
        })}
        <path d={arcPath(smooth)} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" filter="url(#gauge-glow)" opacity="0.7" />
        <path d={arcPath(smooth)} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />
        <text x="64" y="60" textAnchor="middle" className="fill-white font-display" fontSize="22" fontWeight="700">{Math.round(smooth * 100)}</text>
        <text x="64" y="76" textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="9" letterSpacing="1.2">EMISSÃO</text>
      </svg>
      <div className="mt-1 flex h-7 w-full max-w-[150px] items-end gap-[2px]" aria-hidden="true">
        {Array.from({ length: 36 }, (_, i) => {
          const v = bars[bars.length - 36 + i];
          return <span key={i} className="flex-1 rounded-sm transition-[height] duration-300" style={{ height: v == null ? 2 : `${Math.max(8, v * 100)}%`, background: v == null ? 'rgba(255,255,255,0.06)' : intensityColor(v), opacity: v == null ? 1 : 0.35 + 0.65 * (i / 36) }} />;
        })}
      </div>
      <div className="mt-1 text-[10px] text-mist">últimos segundos</div>
    </div>
  );
}
