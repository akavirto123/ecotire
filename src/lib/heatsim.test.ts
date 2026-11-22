import { describe, expect, it } from 'vitest';
import { simulateHeat } from './heatsim';
import type { RiskZone } from './risk';

const b = { south: -23.6, west: -46.7, north: -23.5, east: -46.6 };
const school: RiskZone = { id: 's1', name: 'EE', type: 'school', lat: -23.55, lng: -46.65, radiusM: 120, source: 'osm' };

describe('mapa de calor de exemplo', () => {
  it('fica dentro da área e concentra calor perto das zonas', () => {
    const cells = simulateHeat(b, [school]);
    expect(cells.length).toBeGreaterThan(20);
    for (const c of cells.filter((c) => c.mg > 5)) expect(Math.abs(c.lat - school.lat)).toBeLessThan(0.01);
  });
  it('é estável: o mesmo lugar gera os mesmos pontos', () => {
    expect(simulateHeat(b, [school])).toEqual(simulateHeat(b, [school]));
  });
  it('não fica vazio sem zonas na tela', () => {
    expect(simulateHeat(b, []).length).toBeGreaterThan(50);
  });
});
