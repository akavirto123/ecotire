import { describe, expect, it } from 'vitest';
import { BumpDetector } from './bumps';

const feed = (d: BumpDetector, samples: [number, number][], speed = 40) =>
  samples.map(([z, t]) => d.push(0, 0, z, t, speed)).filter(Boolean);

describe('detector de buracos', () => {
  const smooth = Array.from({ length: 200 }, (_, i) => [9.81 + Math.sin(i) * 0.8, i * 20] as [number, number]);

  it('ignora a vibração normal do asfalto', () => {
    expect(feed(new BumpDetector(), smooth)).toHaveLength(0);
  });

  it('detecta um solavanco forte', () => {
    const d = new BumpDetector();
    feed(d, smooth);
    const hits = feed(d, [[22, 4100], [3, 4120], [9.8, 4140]]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.strengthG).toBeGreaterThan(0.9);
  });

  it('não conta o mesmo buraco duas vezes e ignora baixa velocidade', () => {
    const d = new BumpDetector();
    feed(d, smooth);
    expect(feed(d, [[22, 4100], [22, 4600]])).toHaveLength(1);
    const slow = new BumpDetector();
    feed(slow, smooth, 5);
    expect(feed(slow, [[22, 4100]], 5)).toHaveLength(0);
  });
});
