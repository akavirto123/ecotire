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
  switch (kind) {
    case 'tap': // toque seco e baixo, como tecla de painel
      note(520, 0, 0.05, 0.035, 'triangle', 380);
      break;
    case 'toggle':
      note(660, 0, 0.06, 0.04, 'triangle');
      break;
    case 'start': // duas notas subindo: "vamos"
      note(392, 0, 0.14, 0.07);
      note(587, 0.11, 0.22, 0.07);
      break;
    case 'stop': // duas notas descendo: "chegamos"
      note(587, 0, 0.14, 0.07);
      note(392, 0.11, 0.26, 0.07);
      break;
    case 'report':
      note(740, 0, 0.09, 0.06, 'triangle');
      note(740, 0.12, 0.09, 0.06, 'triangle');
      break;
    case 'level': // arpejo curto de conquista
      [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.09, 0.28, 0.06));
      break;
  }
  if (kind !== 'tap' && kind !== 'toggle' && !muted) {
    try {
      navigator.vibrate?.(kind === 'level' ? [30, 40, 30, 40, 60] : 25);
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
