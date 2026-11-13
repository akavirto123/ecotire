import { useEffect, useMemo, useRef, useState } from 'react';
import { haversine, type Pt } from '@/lib/geo';
import { boundsOf, fetchRoadIssuesInBounds, type BoundingBox } from '@/lib/overpass';
import { mergeZones, type RiskZone } from '@/lib/risk';
import { fetchTileChargers, fetchTileZones, streamTiles, tilesFor, type Charger } from '@/lib/tilezones';

/**
 * Reúne as zonas de risco: reportadas pela comunidade (banco) + detectadas automaticamente
 * no OpenStreetMap ao longo da rota, ao redor do veículo e na área visível do mapa.
 */
export function useRiskZones(community: RiskZone[], routeCoords: Pt[] | undefined, livePos: Pt | null, bounds: BoundingBox | null) {
  const [routeZones, setRouteZones] = useState<RiskZone[]>([]);
  const [nearZones, setNearZones] = useState<RiskZone[]>([]);
  const [mapZones, setMapZones] = useState<RiskZone[]>([]);
  const [routeChargers, setRouteChargers] = useState<Charger[]>([]);
  const [mapChargers, setMapChargers] = useState<Charger[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const lastFetch = useRef<Pt | null>(null);
  const lastFail = useRef(0);
  const fetching = useRef(false);

  useEffect(() => {
    if (!routeCoords || routeCoords.length < 2) {
      setRouteZones([]);
      setRouteChargers([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    setRouteZones([]);
    // fonte principal: os blocos do próprio mapa (rápidos). O Overpass complementa em segundo plano, sem travar a tela.
    const add = (z: RiskZone[]) => !ctrl.signal.aborted && setRouteZones((prev) => mergeZones(prev, z));
    const sampled = routeCoords.filter((_, i) => i % 4 === 0 || i === routeCoords.length - 1);
    // blocos na ordem da rota (do começo para o fim): o trecho de agora aparece primeiro
    const keys = tilesFor(sampled, 250);
    const charged: Charger[] = [];
    // junta as atualizações em lotes para não redesenhar o mapa a cada bloco
    let pending: RiskZone[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (ctrl.signal.aborted) return;
      add(pending);
      pending = [];
      setRouteChargers([...charged]);
    };
    streamTiles(
      keys,
      (t) => {
        pending.push(...t.zones);
        charged.push(...t.chargers.filter((c) => !charged.some((o) => o.id === c.id)));
        timer ??= setTimeout(flush, 250);
      },
      ctrl.signal,
    )
      .then(() => {
        clearTimeout(timer);
        flush();
      })
      .catch(() => !ctrl.signal.aborted && setError(true))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    // Overpass (servidor público, lento): só para rotas curtas e depois que o principal já apareceu.
    // Escolas, hospitais e terra já vêm dos blocos; daqui vêm buracos e lombadas marcados no OSM.
    const b = boundsOf(routeCoords, 200);
    const small = haversine({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east }) < 12000;
    const later = small ? setTimeout(() => void fetchRoadIssuesInBounds(b, ctrl.signal).then(add).catch(() => undefined), 2500) : undefined;
    return () => {
      clearTimeout(later);
      ctrl.abort();
    };
  }, [routeCoords]);

  // ao redor do veículo: refaz a busca a cada ~500 m percorridos
  const lat = livePos?.lat;
  const lng = livePos?.lng;
  useEffect(() => {
    if (lat == null || lng == null || fetching.current) return;
    if (Date.now() - lastFail.current < 20000) return;
    if (lastFetch.current && haversine(lastFetch.current, { lat, lng }) < 500) return;
    fetching.current = true;
    lastFetch.current = { lat, lng };
    fetchTileZones(tilesFor([{ lat, lng }], 1200))
      .then((z) => setNearZones((prev) => mergeZones(prev, z).slice(-600)))
      .catch(() => {
        lastFetch.current = null;
        lastFail.current = Date.now();
      })
      .finally(() => {
        fetching.current = false;
      });
  }, [lat, lng]);

  // área visível do mapa (com espera, para não sobrecarregar o servidor público)
  useEffect(() => {
    if (!bounds) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const corners = [{ lat: bounds.south, lng: bounds.west }, { lat: bounds.north, lng: bounds.east }];
      const [a, b2] = tilesFor(corners, 0).reduce<[number[], number[]]>((acc, k) => { const [x, y] = k.split('/').map(Number); acc[0].push(x); acc[1].push(y); return acc; }, [[], []]);
      const keys: string[] = [];
      for (let x = Math.min(...a); x <= Math.max(...a); x++) for (let y = Math.min(...b2); y <= Math.max(...b2); y++) keys.push(`${x}/${y}`);
      if (keys.length <= 16) {
        fetchTileZones(keys).then((z) => !ctrl.signal.aborted && setMapZones(z)).catch(() => undefined);
        fetchTileChargers(keys).then((c) => !ctrl.signal.aborted && setMapChargers(c)).catch(() => undefined);
      }
    }, 900);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [bounds]);

  const zones = useMemo(() => mergeZones(community, routeZones, nearZones, mapZones), [community, routeZones, nearZones, mapZones]);
  const chargers = useMemo(() => {
    const seen = new Set<string>();
    return [...routeChargers, ...mapChargers].filter((c) => !seen.has(c.id) && seen.add(c.id));
  }, [routeChargers, mapChargers]);
  return { zones, chargers, routeChargers, loading, error };
}
