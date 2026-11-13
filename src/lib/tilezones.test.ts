import { describe, expect, it } from 'vitest';
// @ts-expect-error sem tipos
import vtpbf from 'vt-pbf';
import { decodeTile, keepFeature, zonesFromTile, chargersFromTile } from './tilezones';

// bloco sintético no formato que o OpenFreeMap entrega: escola, hospital, carregador, estrada de terra e muitos prédios
const pt = (x: number, y: number, tags: Record<string, unknown>) => ({ type: 1, geometry: [[x, y]], tags, id: undefined });
const line = (pts: number[][], tags: Record<string, unknown>) => ({ type: 2, geometry: [pts], tags, id: undefined });
const layer = (name: string, features: unknown[]) => ({ name, extent: 4096, length: features.length, feature: (i: number) => wrap(features[i] as never, 4096) });
function wrap(f: { type: number; geometry: number[][] | number[][][]; tags: Record<string, unknown> }, extent: number) {
  return {
    type: f.type,
    properties: f.tags,
    extent,
    loadGeometry: () => (f.type === 1 ? (f.geometry as number[][]).map(([x, y]) => [{ x, y }]) : (f.geometry as number[][][]).map((r) => r.map(([x, y]) => ({ x, y })))),
  };
}
const buildings = Array.from({ length: 3000 }, (_, i) => line([[i % 4000, 10], [i % 4000 + 5, 15], [i % 4000, 20]], { render_height: 10 }));
const buf: Uint8Array = vtpbf({
  layers: {
    poi: layer('poi', [pt(100, 100, { class: 'school', name: 'EE Teste' }), pt(2000, 2000, { class: 'hospital', subclass: 'hospital', name: 'Hospital X' }), pt(300, 300, { class: 'cafe', name: 'Café' }), pt(900, 900, { class: 'fuel', subclass: 'charging_station', name: 'Recarga' })]),
    transportation: layer('transportation', [line([[0, 0], [400, 400], [800, 800]], { class: 'minor', surface: 'unpaved' }), line([[0, 50], [4000, 50]], { class: 'primary', surface: 'paved' })]),
    building: layer('building', buildings),
  },
});

describe('leitura dos blocos do mapa', () => {
  it('lê só o que vira zona ou carregador', () => {
    const layers = decodeTile(buf, ['poi', 'transportation'], keepFeature);
    expect(layers.building).toBeUndefined();
    expect(layers.poi.features).toHaveLength(3);
    expect(layers.transportation.features).toHaveLength(1);
    const zones = zonesFromTile(6070, 9300, layers);
    expect(zones.map((z) => z.type).sort()).toEqual(['hospital', 'pavement', 'school']);
    expect(zones.find((z) => z.type === 'school')!.name).toBe('EE Teste');
    expect(chargersFromTile(6070, 9300, layers)).toHaveLength(1);
  });

  it('sem filtro continua lendo tudo das camadas pedidas', () => {
    const layers = decodeTile(buf, ['poi']);
    expect(layers.poi.features).toHaveLength(4);
    expect(layers.poi.features[0]!.points[0]).toEqual([100, 100]);
  });
});

