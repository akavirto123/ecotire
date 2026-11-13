import { RISK_META, isSchoolRush, type RiskAlert } from '@/lib/risk';

let ctx: AudioContext | null = null;

/** Precisa ser chamado a partir de um clique (regra dos navegadores) para liberar o áudio. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    // "aquece" a síntese de voz no iOS
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
  } catch {
    /* sem áudio neste dispositivo */
  }
}

function tone(freq: number, startS: number, durS: number, gain = 0.18) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startS;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + durS);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durS + 0.05);
}

export function playChime(urgent: boolean) {
  if (urgent) {
    tone(880, 0, 0.18, 0.22);
    tone(880, 0.24, 0.18, 0.22);
    tone(1175, 0.48, 0.3, 0.22);
  } else {
    tone(660, 0, 0.2);
    tone(880, 0.22, 0.28);
  }
}

export function speak(text: string) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    u.rate = 1.05;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
    if (voice) u.voice = voice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* sem voz neste dispositivo */
  }
}

export function alertMessage(a: RiskAlert): string {
  const meta = RISK_META[a.zone.type];
  const rush = a.zone.type === 'school' && isSchoolRush() ? ' Horário de entrada e saída de alunos.' : '';
  if (a.stage === 'inside') return `Você está em ${meta.voice}. Mantenha até ${a.advisedKmh} quilômetros por hora e evite frear ou acelerar forte.${rush}`;
  const dist = Math.round(a.distanceM / 10) * 10;
  return `${meta.voice} a ${dist} metros. Reduza suavemente para ${a.advisedKmh} quilômetros por hora.${rush}`;
}

/** Aviso sonoro + voz + vibração para um alerta de zona de risco. */
export function announce(a: RiskAlert, soundOn: boolean) {
  const urgent = a.stage === 'inside';
  try {
    navigator.vibrate?.(urgent ? [200, 100, 200] : [150]);
  } catch {
    /* sem vibração */
  }
  if (!soundOn) return;
  playChime(urgent);
  window.setTimeout(() => speak(alertMessage(a)), urgent ? 850 : 600);
}
