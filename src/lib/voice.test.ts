import { describe, expect, it } from 'vitest';
import { alertMessage, voiceKey } from './alerts';
import { RISK_META, type RiskType } from './risk';
import recorded from '../../public/voice/index.json';


const manifest = recorded.texts as Record<string, string>;
const clips = recorded.clips as Record<string, Record<string, number[]>>;

describe('voz de IA gravada', () => {
  it('a chave do app é a mesma usada ao gerar os áudios', () => {
    for (const [k, text] of Object.entries(manifest)) expect(voiceKey(text)).toBe(k);
  });

  it('as duas vozes têm o trecho de cada frase', () => {
    for (const v of ['dora', 'alex']) for (const k of Object.keys(manifest)) expect(clips[v]![k]![1]).toBeGreaterThan(0.5);
  });

  it('todo aviso de zona tem áudio gravado (fora do horário escolar)', () => {
    const types = Object.keys(RISK_META) as RiskType[];
    for (const type of types) {
      const zone = { id: 'z', name: 'z', type, lat: 0, lng: 0, radiusM: 100, source: 'osm' as const };
      const a = { zone, stage: 'approaching' as const, distanceM: 0, etaS: null, advisedKmh: RISK_META[type].advisedKmh };
      for (let d = 0; d <= 620; d += 7) {
        const text = alertMessage({ ...a, distanceM: d });
        if (!text.includes('Horário')) expect(manifest[voiceKey(text)], text).toBe(text);
      }
      const inside = alertMessage({ ...a, stage: 'inside' });
      if (!inside.includes('Horário')) expect(manifest[voiceKey(inside)]).toBe(inside);
    }
  });
});
