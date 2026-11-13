import { useEffect, useMemo, useRef, useState } from 'react';
import { haversine, type Pt } from '@/lib/geo';
import { boundsOf, fetchRoadIssuesInBounds, fetchSensitiveInBounds, fetchZonesAround, type BoundingBox } from '@/lib/overpass';
import { mergeZones, type RiskZone } from '@/lib/risk';
import { fetchTileChargers, fetchTileZones, tilesFor, type Charger } from '@/lib/tilezones';

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
    const keys = tilesFor(sampled, 300);
    void fetchTileChargers(keys).then((c) => !ctrl.signal.aborted && setRouteChargers(c)).catch(() => undefined);
    fetchTileZones(keys)
      .then(add)
      .catch(() => !ctrl.signal.aborted && setError(true))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    const b = boundsOf(routeCoords, 300);
    void fetchSensitiveInBounds(b, ctrl.signal).then(add).catch(() => undefined);
    void fetchRoadIssuesInBounds(b, ctrl.signal).then(add).catch(() => undefined);
    return () => ctrl.abort();
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
    void fetchZonesAround({ lat, lng }, 1200).then((z) => setNearZones((prev) => mergeZones(prev, z).slice(-600))).catch(() => undefined);
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
      if (keys.length <= 30) {
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
