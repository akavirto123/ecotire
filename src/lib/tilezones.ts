/**
 * Zonas de risco lidas dos próprios blocos vetoriais do mapa (OpenFreeMap / esquema OpenMapTiles).
 * É a fonte principal: os blocos vêm de CDN e respondem em milissegundos, enquanto os servidores públicos
 * do Overpass costumam demorar dezenas de segundos ou cair. O Overpass continua como complemento.
 *
 * Inclui um leitor mínimo do formato Mapbox Vector Tile (protobuf), só com o que o app precisa.
 */
import { haversine, type Pt } from '@/lib/geo';
import { DEFAULT_RADIUS_M, type RiskType, type RiskZone } from '@/lib/risk';

const Z = 14;
const TILEJSON = 'https://tiles.openfreemap.org/planet';

// ---------- leitor de protobuf ----------

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }
  /** Lê os campos de uma mensagem: chama `field(numero, tipo)`; o que não for consumido é pulado. */
  fields(field: (num: number, wire: number) => boolean) {
    while (this.pos < this.end) {
      const tag = this.varint();
      const wire = tag & 7;
      if (field(tag >>> 3, wire)) continue;
      if (wire === 0) this.varint();
      else if (wire === 1) this.pos += 8;
      else if (wire === 2) {
        const len = this.varint(); // ler o tamanho antes: `pos += varint()` perderia os bytes do próprio tamanho
        this.pos += len;
      }
      else if (wire === 5) this.pos += 4;
      else throw new Error('protobuf inválido');
    }
  }
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  string(): string {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  packed(): number[] {
    const len = this.varint();
    const end = this.pos + len;
    const out: number[] = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
}

export type TileFeature = { type: number; props: Record<string, string | number | boolean>; points: [number, number][] };
export type TileLayers = Record<string, { extent: number; features: TileFeature[] }>;

const zigzag = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);

/** Decodifica as camadas pedidas de um bloco vetorial. */
export type FeatureFilter = (layer: string, props: TileFeature['props'], type: number) => boolean;
export function decodeTile(buf: Uint8Array, wanted: string[], keep?: FeatureFilter): TileLayers {
  const out: TileLayers = {};
  const top = new Reader(buf);
  top.fields((num, wire) => {
    if (num !== 3 || wire !== 2) return false;
    const layer = top.sub();
    // primeiro só o nome (pular campos é barato): camadas pesadas como prédios nem são decodificadas
    const start = layer.pos;
    let layerName = '';
    layer.fields((n, w) => {
      if (n === 1 && w === 2) {
        layerName = layer.string();
        return true;
      }
      return false;
    });
    if (!wanted.includes(layerName)) return true;
    layer.pos = start;
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const raw: { type: number; tags: number[]; geomAt: number; geomEnd: number }[] = [];
    layer.fields((n, w) => {
      if (n === 1 && w === 2) name = layer.string();
      else if (n === 5 && w === 0) extent = layer.varint();
      else if (n === 3 && w === 2) keys.push(layer.string());
      else if (n === 4 && w === 2) {
        const v = layer.sub();
        let val: string | number | boolean = '';
        v.fields((vn, vw) => {
          if (vn === 1 && vw === 2) val = v.string();
          else if ((vn === 4 || vn === 5) && vw === 0) val = v.varint();
          else if (vn === 6 && vw === 0) val = zigzag(v.varint());
          else if (vn === 7 && vw === 0) val = v.varint() !== 0;
          else if (vn === 2 && vw === 5) {
            val = new DataView(v.buf.buffer, v.buf.byteOffset + v.pos, 4).getFloat32(0, true);
            v.pos += 4;
          } else if (vn === 3 && vw === 1) {
            val = new DataView(v.buf.buffer, v.buf.byteOffset + v.pos, 8).getFloat64(0, true);
            v.pos += 8;
          } else return false;
          return true;
        });
        values.push(val);
      } else if (n === 2 && w === 2) {
        const f = layer.sub();
        const feat = { type: 0, tags: [] as number[], geomAt: -1, geomEnd: -1 };
        f.fields((fn, fw) => {
          if (fn === 3 && fw === 0) feat.type = f.varint();
          else if (fn === 2 && fw === 2) feat.tags = f.packed();
          else if (fn === 4 && fw === 2) {
            // geometria só é lida depois, e só para as feições que interessam
            const len = f.varint();
            feat.geomAt = f.pos;
            feat.geomEnd = f.pos + len;
            f.pos += len;
          } else return false;
          return true;
        });
        raw.push(feat);
      } else return false;
      return true;
    });
    if (!wanted.includes(name)) return true;
    out[name] = {
      extent,
      features: raw.flatMap((f) => {
        const props: TileFeature['props'] = {};
        for (let i = 0; i + 1 < f.tags.length; i += 2) props[keys[f.tags[i]]] = values[f.tags[i + 1]];
        if (keep && !keep(name, props, f.type)) return [];
        const g = new Reader(buf, f.geomEnd);
        g.pos = f.geomAt;
        const geom: number[] = [];
        if (f.geomAt >= 0) while (g.pos < f.geomEnd) geom.push(g.varint());
        const points: [number, number][] = [];
        let x = 0;
        let y = 0;
        for (let i = 0; i < geom.length; ) {
          const cmd = geom[i] & 7;
          const count = geom[i] >>> 3;
          i++;
          if (cmd === 7) continue;
          for (let k = 0; k < count; k++) {
            x += zigzag(geom[i++]);
            y += zigzag(geom[i++]);
            points.push([x, y]);
          }
        }
        return [{ type: f.type, props, points }];
      }),
    };
    return true;
  });
  return out;
}

// ---------- blocos ----------

const tileX = (lng: number) => Math.floor(((lng + 180) / 360) * 2 ** Z);
const tileY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};
/** Converte coordenada interna do bloco em lat/lng. */
export function tilePoint(tx: number, ty: number, px: number, py: number, extent: number): Pt {
  const n = 2 ** Z;
  const lng = ((tx + px / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI;
  return { lat, lng };
}

/** Blocos (zoom 14) tocados pelos pontos, com folga em metros. */
export function tilesFor(points: Pt[], padM = 300): string[] {
  const keys = new Set<string>();
  for (const p of points) {
    const dLat = padM / 111320;
    const dLng = padM / (111320 * Math.cos((p.lat * Math.PI) / 180));
    for (const [a, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) keys.add(`${tileX(p.lng + b * dLng)}/${tileY(p.lat + a * dLat)}`);
  }
  return [...keys];
}

const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);

/** Extrai as zonas de risco de um bloco já decodificado. */
export function zonesFromTile(tx: number, ty: number, layers: TileLayers): RiskZone[] {
  const out: RiskZone[] = [];
  const push = (type: RiskType, name: string, p: Pt, id: string) => out.push({ id, name, type, lat: p.lat, lng: p.lng, radiusM: DEFAULT_RADIUS_M[type], source: 'osm' });
  const poi = layers.poi;
  for (const f of poi?.features ?? []) {
    if (!f.points.length) continue;
    const cls = f.props.class;
    const sub = f.props.subclass;
    const type: RiskType | null = cls === 'school' ? 'school' : cls === 'hospital' && (sub === 'hospital' || sub == null) ? 'hospital' : null;
    if (!type) continue;
    const p = tilePoint(tx, ty, f.points[0][0], f.points[0][1], poi.extent);
    const name = String(f.props['name:pt'] ?? f.props.name ?? (type === 'school' ? 'Escola (sem nome)' : 'Hospital (sem nome)'));
    push(type, name, p, `t-${type}-${p.lat.toFixed(5)}-${p.lng.toFixed(5)}`);
  }
  const roads = layers.transportation;
  const rough: Pt[] = [];
  for (const f of roads?.features ?? []) {
    if (f.type !== 2 || f.props.surface !== 'unpaved' || !ROAD_CLASSES.has(String(f.props.class)) || f.points.length < 2) continue;
    const mid = f.points[Math.floor(f.points.length / 2)];
    const p = tilePoint(tx, ty, mid[0], mid[1], roads.extent);
    if (rough.some((q) => haversine(q, p) < 160)) continue; // um aviso por trecho, não um por segmento
    rough.push(p);
    push('pavement', 'Trecho sem pavimento', p, `t-pav-${p.lat.toFixed(4)}-${p.lng.toFixed(4)}`);
  }
  return out;
}

/** Ponto de recarga de carro elétrico lido do mapa (OpenStreetMap: amenity=charging_station). */
export type Charger = { id: string; name: string; lat: number; lng: number };

export function chargersFromTile(tx: number, ty: number, layers: TileLayers): Charger[] {
  const poi = layers.poi;
  const out: Charger[] = [];
  for (const f of poi?.features ?? []) {
    if (!f.points.length || f.props.subclass !== 'charging_station') continue;
    const p = tilePoint(tx, ty, f.points[0][0], f.points[0][1], poi.extent);
    out.push({ id: `c-${p.lat.toFixed(5)}-${p.lng.toFixed(5)}`, name: String(f.props['name:pt'] ?? f.props.name ?? 'Ponto de recarga'), ...p });
  }
  return out;
}

/** Só as feições que viram zona ou carregador: o resto do bloco nem tem a geometria lida. */
export const keepFeature: FeatureFilter = (layer, p, type) =>
  layer === 'poi'
    ? p.class === 'school' || p.class === 'hospital' || p.subclass === 'charging_station'
    : type === 2 && p.surface === 'unpaved' && ROAD_CLASSES.has(String(p.class));

export type TileData = { zones: RiskZone[]; chargers: Charger[] };
let template: Promise<string> | null = null;
const cache = new Map<string, Promise<TileData>>();

function loadTile(key: string): Promise<TileData> {
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      template ??= fetch(TILEJSON).then((r) => r.json()).then((j) => (j.tiles as string[])[0]);
      const [x, y] = key.split('/').map(Number);
      const res = await fetch((await template).replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!res.ok) throw new Error(`bloco ${res.status}`);
      const layers = decodeTile(new Uint8Array(await res.arrayBuffer()), ['poi', 'transportation'], keepFeature);
      return { zones: zonesFromTile(x, y, layers), chargers: chargersFromTile(x, y, layers) };
    })();
    cache.set(key, p);
    p.catch(() => {
      cache.delete(key);
      template = null;
    });
  }
  return p;
}

/** No máximo 4 downloads ao mesmo tempo: o mapa também está baixando blocos e não pode ficar na fila. */
const MAX_PARALLEL = 4;
let running = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await job();
  } finally {
    running--;
    queue.shift()?.();
  }
}

async function fetchTiles(keys: string[], limit: number): Promise<TileData[]> {
  const results = await Promise.allSettled(keys.slice(0, limit).map((k) => (cache.has(k) ? loadTile(k) : withSlot(() => loadTile(k)))));
  if (results.length && results.every((r) => r.status === 'rejected')) throw new Error('mapa indisponível');
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

/** Zonas de risco dos blocos indicados (no máximo `limit` blocos por chamada). */
export async function fetchTileZones(keys: string[], limit = 80): Promise<RiskZone[]> {
  return (await fetchTiles(keys, limit)).flatMap((t) => t.zones);
}

/** Carregadores dos blocos indicados (usa o mesmo cache: não baixa nada a mais). */
export async function fetchTileChargers(keys: string[], limit = 80): Promise<Charger[]> {
  const seen = new Set<string>();
  return (await fetchTiles(keys, limit)).flatMap((t) => t.chargers).filter((c) => !seen.has(c.id) && seen.add(c.id));
}

/**
 * Entrega bloco por bloco, na ordem dada (o chamador põe os mais próximos primeiro),
 * para as zonas irem aparecendo sem esperar a rota inteira.
 */
export async function streamTiles(keys: string[], onTile: (t: TileData) => void, signal?: AbortSignal, limit = 80): Promise<number> {
  let ok = 0;
  await Promise.allSettled(
    keys.slice(0, limit).map((k) =>
      (cache.has(k) ? loadTile(k) : withSlot(() => (signal?.aborted ? Promise.reject(new Error('cancelado')) : loadTile(k)))).then((t) => {
        ok++;
        if (!signal?.aborted) onTile(t);
      }),
    ),
  );
  if (!ok && keys.length && !signal?.aborted) throw new Error('mapa indisponível');
  return ok;
}
