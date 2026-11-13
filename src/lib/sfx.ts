/** Sons curtos da interface, sintetizados na hora (sem arquivos de áudio). Respeitam o botão de mudo. */
let ctx: AudioContext | null = null;
let muted = false;

export function setSfxMuted(m: boolean) {
  muted = m;
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function note(freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
  const c = audio();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  const t = c.currentTime + at;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

export type Sfx = 'tap' | 'toggle' | 'start' | 'stop' | 'level' | 'report';

export function sfx(kind: Sfx) {
  // sons suaves e raros: nada de clique em cada botão, só nos momentos que importam
  switch (kind) {
    case 'tap':
    case 'toggle':
      return;
    case 'start': // sino suave subindo
      note(523, 0, 0.35, 0.03);
      note(784, 0.09, 0.45, 0.025);
      break;
    case 'stop': // sino suave descendo
      note(784, 0, 0.35, 0.025);
      note(523, 0.1, 0.5, 0.03);
      break;
    case 'report': // "plim" único
      note(880, 0, 0.3, 0.025);
      break;
    case 'level': // acorde aberto, curto e baixo
      [523, 659, 784].forEach((f, i) => note(f, i * 0.07, 0.6, 0.022));
      break;
  }
  if (!muted) {
    try {
      navigator.vibrate?.(kind === 'level' ? [30, 40, 30] : 20);
    } catch {
      /* sem vibração */
    }
  }
}

/** Liga o som de toque em todos os botões e seletores do app. */
export function installTapSounds(): () => void {
  const onDown = (e: PointerEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.('button, [role="menuitemradio"], select, input[type="checkbox"], a[href]');
    if (el && !(el as HTMLButtonElement).disabled && !el.hasAttribute('data-quiet')) sfx('tap');
  };
  window.addEventListener('pointerdown', onDown, { passive: true });
  return () => window.removeEventListener('pointerdown', onDown);
}
