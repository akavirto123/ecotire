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

let voiceEnabled = true;
/** Modo "só bipe": mantém os sons e desliga a fala. */
export function setVoiceEnabled(v: boolean) {
  voiceEnabled = v;
  if (!v && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Prefere as vozes neurais (Edge "Natural"/"Online", Google) e evita português de Portugal. */
function voiceScore(v: SpeechSynthesisVoice): number {
  const lang = v.lang?.toLowerCase().replace('_', '-') ?? '';
  if (!lang.startsWith('pt')) return -1;
  let s = lang === 'pt-br' ? 100 : 10;
  if (/natural|neural|online/i.test(v.name)) s += 60;
  if (/google/i.test(v.name)) s += 40;
  if (/francisca|thalita|antonio|luciana|felipe/i.test(v.name)) s += 20;
  if (/maria|daniel|heloisa/i.test(v.name)) s -= 5; // vozes antigas do Windows, mais robóticas
  if (!v.localService) s += 5;
  return s;
}
let bestVoice: SpeechSynthesisVoice | null = null;
function pickVoice(): SpeechSynthesisVoice | null {
  if (bestVoice) return bestVoice;
  const voices = window.speechSynthesis.getVoices().filter((v) => voiceScore(v) >= 0);
  bestVoice = voices.sort((a, b) => voiceScore(b) - voiceScore(a))[0] ?? null;
  return bestVoice;
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    bestVoice = null;
  });
}

export function speak(text: string) {
  try {
    if (!voiceEnabled || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    const voice = pickVoice();
    if (voice) u.voice = voice;
    // vozes neurais já soam naturais na velocidade normal; as antigas ficam melhores um pouco mais lentas
    u.rate = voice && /natural|neural|online|google/i.test(voice.name) ? 1.0 : 0.95;
    u.pitch = 1;
    u.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* sem voz neste dispositivo */
  }
}

export function alertMessage(a: RiskAlert): string {
  const meta = RISK_META[a.zone.type];
  const rush = a.zone.type === 'school' && isSchoolRush() ? ' Horário de entrada e saída de alunos.' : '';
  if (a.stage === 'inside') return `Você está em ${meta.voice}. Até ${a.advisedKmh}, sem frear forte.${rush}`;
  const dist = Math.round(a.distanceM / 50) * 50 || 50;
  return `${meta.voice} em ${dist} metros. Reduza para ${a.advisedKmh}.${rush}`;
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
