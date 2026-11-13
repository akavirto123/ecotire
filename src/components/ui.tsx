import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Cartão que inclina em 3D seguindo o mouse ou o dedo. */
export function Tilt({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const set = (rx: number, ry: number) => {
    ref.current?.style.setProperty('--rx', `${rx}deg`);
    ref.current?.style.setProperty('--ry', `${ry}deg`);
  };
  return (
    <div
      ref={ref}
      className={`tilt ${className}`}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        set(-((e.clientY - r.top) / r.height - 0.5) * 12, ((e.clientX - r.left) / r.width - 0.5) * 12);
      }}
      onPointerLeave={() => set(0, 0)}
    >
      {children}
    </div>
  );
}

/** Mostra "12.3 mg" contando de onde estava até o novo valor. */
export function AnimatedValue({ value }: { value: string }) {
  const m = /^([^\d-]*)(-?\d+(?:[.,]\d+)?)(.*)$/.exec(value);
  const target = m ? parseFloat(m[2].replace(',', '.')) : NaN;
  const decimals = m ? (m[2].split(/[.,]/)[1]?.length ?? 0) : 0;
  const [shown, setShown] = useState(target);
  const from = useRef(Number.isFinite(target) ? 0 : target);

  useEffect(() => {
    if (!Number.isFinite(target) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const v = a + (target - a) * (1 - (1 - t) ** 3);
      setShown(v);
      from.current = v;
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  if (!m || !Number.isFinite(target)) return <>{value}</>;
  return <>{m[1]}{shown.toFixed(decimals)}{m[3]}</>;
}

export type TourStep = { title: string; text: string };

/** Tour guiado: cartão central com passos. */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const last = i === steps.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Tour do EcoTire">
      <div key={i} className="glass pop-in w-full max-w-md rounded-3xl p-6">
        <div className="mb-3 flex gap-1.5" aria-hidden="true">
          {steps.map((_, k) => <span key={k} className={`h-1.5 flex-1 rounded-full ${k <= i ? 'bg-eco' : 'bg-line'}`} />)}
        </div>
        <p className="text-xs font-semibold text-eco">Passo {i + 1} de {steps.length}</p>
        <h2 className="mt-1 font-display text-2xl font-semibold">{steps[i].title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-mist">{steps[i].text}</p>
        <div className="mt-6 flex items-center gap-2">
          <button type="button" className="text-sm text-mist hover:text-white" onClick={onClose}>Pular</button>
          <div className="ml-auto flex gap-2">
            {i > 0 && <button type="button" className="btn btn-ghost" onClick={() => setI(i - 1)}>Voltar</button>}
            <button type="button" className="btn btn-eco" autoFocus onClick={() => (last ? onClose() : setI(i + 1))}>{last ? 'Começar' : 'Próximo'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
