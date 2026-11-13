import { LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { AirOverlay, type AirEmitter, type AirTone } from '@/components/AirOverlay';
import { circleRing, type Pt } from '@/lib/geo';
import type { Charger } from '@/lib/tilezones';
import type { BoundingBox } from '@/lib/overpass';
import { RISK_META, type RiskZone } from '@/lib/risk';

setWorkerUrl(workerUrl);

export type MapRoute = { coords: Pt[]; selected: boolean; cleanest: boolean };
export type MapColumn = Pt & { mgPerKm: number; level: 'low' | 'moderate' | 'high' };

type Props = {
  /** modo leve: sem prédios 3D, menos partículas, menor resolução */
  lite?: boolean;
  origin: Pt | null;
  destination: Pt | null;
  routes: MapRoute[];
  zones: RiskZone[];
  /** ids das zonas em alerta agora (ficam mais altas e opacas) */
  activeZoneIds: string[];
  live: (Pt & { heading: number }) | null;
  trail: Pt[];
  /** colunas 3D de emissão ao longo do trajeto percorrido */
  columns: MapColumn[];
  /** mapa de calor da comunidade (null = desligado) */
  heat: { lat: number; lng: number; mg: number }[] | null;
  chargers: Charger[];
  /** emissão estimada do carro agora (0 a 1) e o nível, para a nuvem de partículas */
  liveIntensity: number;
  liveLevel: 'low' | 'moderate' | 'high';
  /** névoa sobre a rota escolhida: PM2.5 estimado por km */
  routeHaze: { coords: Pt[]; mgPerKm: number } | null;
  follow: boolean;
  /** modo "clique no mapa para reportar zona" */
  picking: boolean;
  /** espaço ocupado pelos painéis, para centralizar a rota na área livre */
  padding: { top: number; bottom: number; left: number; right: number };
  /** paleta atual: a rota escolhida usa a cor de destaque */
  theme: string;
  onPick: (p: Pt) => void;
  onBounds: (b: BoundingBox | null) => void;
  onSelectRoute: (index: number) => void;
};

const STYLE_MAIN = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_FALLBACK = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_CENTER: [number, number] = [-47.4526, -23.5015]; // Sorocaba-SP
const EMPTY = { type: 'FeatureCollection' as const, features: [] };

async function loadStyle(): Promise<StyleSpecification | string> {
  try {
    const res = await fetch(STYLE_MAIN);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as StyleSpecification;
  } catch {
    return STYLE_FALLBACK;
  }
}

const line = (coords: Pt[]) => ({ type: 'LineString' as const, coordinates: coords.map((p) => [p.lng, p.lat]) });

function dotMarker(color: string, label: string): HTMLDivElement {
  // o MapLibre controla o transform do elemento externo; a gota fica num elemento interno
  const wrap = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'eco-pin';
  el.style.setProperty('--pin', color);
  const span = document.createElement('span');
  span.textContent = label;
  el.appendChild(span);
  wrap.appendChild(el);
  return wrap;
}

export function Map3D(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const markers = useRef<{ origin?: Marker; destination?: Marker; live?: Marker }>({});
  const cb = useRef(props);
  cb.current = props;

  // cria o mapa uma única vez
  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    loadStyle().then((style) => {
      if (cancelled || !container.current) return;
      // abertura: o mapa começa do alto e mergulha até a rua
      const intro = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try {
        map = new MlMap({
          container: container.current,
          style,
          center: DEFAULT_CENTER,
          zoom: intro ? 11.8 : 14.5,
          pitch: intro ? 0 : 58,
          bearing: intro ? 0 : -18,
          maxPitch: 75,
          // só o estado de São Paulo, com folga: deixa o mapa leve e focado
          maxBounds: [[-54.2, -26.3], [-43.2, -18.9]],
          minZoom: 5.5,
          pixelRatio: props.lite ? Math.min(window.devicePixelRatio || 1, 1.25) : undefined,
          fadeDuration: props.lite ? 0 : undefined,
          attributionControl: { compact: true },
        });
      } catch {
        setFailed(true); // navegador sem WebGL
        return;
      }
      mapRef.current = map;
      if (window.matchMedia('(min-width: 1024px)').matches) map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

      map.on('load', () => {
        if (!map) return;
        // prédios em 3D a partir da camada vetorial do OpenStreetMap
        const sources = map.getStyle().sources ?? {};
        const vector = Object.keys(sources).find((k) => sources[k].type === 'vector');
        for (const l of map.getStyle().layers ?? []) {
          if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', 'none');
        }
        if (vector) {
          map.addLayer({
            id: 'eco-buildings',
            type: 'fill-extrusion',
            source: vector,
            'source-layer': 'building',
            minzoom: 13.5,
            paint: {
              'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#1a1c21', 40, '#262a31', 150, '#3a404b'],
              'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, ['coalesce', ['get', 'render_height'], 6]],
              'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
              'fill-extrusion-opacity': 0.92,
            },
          });
        }

        for (const id of ['heat', 'zones', 'zone-dots', 'routes', 'trail', 'columns', 'chargers']) map.addSource(id, { type: 'geojson', data: EMPTY });

        // mapa de calor: onde a comunidade mais emitiu particulado
        map.addLayer({
          id: 'heat',
          type: 'heatmap',
          source: 'heat',
          maxzoom: 18,
          paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'mg'], 0, 0, 3, 0.5, 15, 1],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 1.8],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 42],
            'heatmap-opacity': 0.75,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, '#34d399', 0.5, '#fbbf24', 0.8, '#fb923c', 1, '#fb7185'],
          },
        });
        map.addLayer({
          id: 'zones-3d',
          type: 'fill-extrusion',
          source: 'zones',
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-opacity': 0.34,
          },
        });
        map.addLayer({
          id: 'zone-dots',
          type: 'circle',
          source: 'zone-dots',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 7],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0e0f12',
            'circle-stroke-width': 1.5,
          },
        });
        map.addLayer({
          id: 'routes-alt',
          type: 'line',
          source: 'routes',
          filter: ['!', ['get', 'selected']],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#8fa3b1', 'line-width': 5, 'line-opacity': 0.7 },
        });
        map.addLayer({
          id: 'routes-glow',
          type: 'line',
          source: 'routes',
          filter: ['get', 'selected'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['case', ['get', 'cleanest'], '#34d399', '#60a5fa'], 'line-width': 16, 'line-opacity': 0.25, 'line-blur': 8 },
        });
        map.addLayer({
          id: 'routes-main',
          type: 'line',
          source: 'routes',
          filter: ['get', 'selected'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['case', ['get', 'cleanest'], '#34d399', '#60a5fa'], 'line-width': 5.5 },
        });
        map.addLayer({
          id: 'trail',
          type: 'line',
          source: 'trail',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#f4f4f5', 'line-width': 3, 'line-opacity': 0.8 },
        });
        // traços claros "correndo" sobre a rota escolhida
        map.addLayer({
          id: 'routes-flow',
          type: 'line',
          source: 'routes',
          filter: ['get', 'selected'],
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [0, 4, 3] },
        });
        // colunas 3D de emissão
        map.addLayer({
          id: 'columns-3d',
          type: 'fill-extrusion',
          source: 'columns',
          paint: {
            'fill-extrusion-color': ['match', ['get', 'level'], 'high', '#fb7185', 'moderate', '#fbbf24', '#34d399'],
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-opacity': 0.82,
          },
        });
        try {
          map.setSky({ 'sky-color': '#07080b', 'horizon-color': '#20232b', 'fog-color': '#0e0f12', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.55 });
        } catch {
          /* versão sem suporte a céu */
        }
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const DASHES = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
          let step = 0;
          const flow = window.setInterval(() => {
            if (!map || !map.getLayer('routes-flow')) return;
            step = (step + 1) % DASHES.length;
            map.setPaintProperty('routes-flow', 'line-dasharray', DASHES[step]);
          }, 70);
          map.once('remove', () => window.clearInterval(flow));
        }

        map.addLayer({
          id: 'chargers',
          type: 'circle',
          source: 'chargers',
          minzoom: 9,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 16, 9],
            'circle-color': '#5cc8ff',
            'circle-stroke-color': '#0c0c0d',
            'circle-stroke-width': 2,
            'circle-blur': 0.1,
          },
        });
        map.on('click', 'chargers', (e) => {
          const f = e.features?.[0];
          if (!f || cb.current.picking) return;
          const el = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = String(f.properties?.name ?? 'Ponto de recarga');
          const sub = document.createElement('div');
          sub.textContent = 'Recarga de carro elétrico · OpenStreetMap';
          el.append(title, sub);
          new Popup({ closeButton: false, offset: 10 }).setLngLat(e.lngLat).setDOMContent(el).addTo(map!);
        });
        map.on('click', 'zone-dots', (e) => {
          const f = e.features?.[0];
          if (!f || cb.current.picking) return;
          const p = f.properties as { name: string; label: string; source: string };
          const el = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = p.name;
          const sub = document.createElement('div');
          sub.textContent = `${p.label} · ${p.source === 'osm' ? 'OpenStreetMap' : 'reportada por usuários'}`;
          el.append(title, sub);
          new Popup({ closeButton: false, offset: 10 }).setLngLat(e.lngLat).setDOMContent(el).addTo(map!);
        });
        map.on('click', 'routes-alt', (e) => {
          const idx = e.features?.[0]?.properties?.index;
          if (typeof idx === 'number' && !cb.current.picking) cb.current.onSelectRoute(idx);
        });
        map.on('click', (e) => {
          if (cb.current.picking) cb.current.onPick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        });
        for (const id of ['zone-dots', 'routes-alt', 'chargers']) {
          map.on('mouseenter', id, () => (map!.getCanvas().style.cursor = 'pointer'));
          map.on('mouseleave', id, () => (map!.getCanvas().style.cursor = ''));
        }
        const emitBounds = () => {
          if (!map) return;
          if (map.getZoom() < 13) return cb.current.onBounds(null);
          const b = map.getBounds();
          cb.current.onBounds({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
        };
        map.on('moveend', emitBounds);
        emitBounds();
        setReady(true);
        if (intro && !cb.current.routes.length && !cb.current.follow) map.easeTo({ zoom: 14.5, pitch: 58, bearing: -18, duration: 2800, easing: (t) => 1 - (1 - t) ** 4 });
      });
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  const map = ready ? mapRef.current : null;

  // prédios 3D são a parte mais pesada do mapa: somem no modo leve
  useEffect(() => {
    if (!map) return;
    if (map.getLayer('eco-buildings')) map.setLayoutProperty('eco-buildings', 'visibility', props.lite ? 'none' : 'visible');
    map.setPixelRatio(props.lite ? Math.min(window.devicePixelRatio || 1, 1.25) : window.devicePixelRatio || 1);
  }, [map, props.lite]);

  // zonas de risco (cilindros 3D + pontos clicáveis)
  const activeKey = props.activeZoneIds.join(',');
  useEffect(() => {
    if (!map) return;
    const active = new Set(props.activeZoneIds);
    const polys = props.zones.map((z) => ({
      type: 'Feature' as const,
      properties: { color: RISK_META[z.type].color, height: active.has(z.id) ? 70 : 26 },
      geometry: { type: 'Polygon' as const, coordinates: [circleRing(z, z.radiusM)] },
    }));
    const dots = props.zones.map((z) => ({
      type: 'Feature' as const,
      properties: { color: RISK_META[z.type].color, name: z.name, label: RISK_META[z.type].label, source: z.source },
      geometry: { type: 'Point' as const, coordinates: [z.lng, z.lat] },
    }));
    (map.getSource('zones') as GeoJSONSource).setData({ type: 'FeatureCollection', features: polys });
    (map.getSource('zone-dots') as GeoJSONSource).setData({ type: 'FeatureCollection', features: dots });
  }, [map, props.zones, activeKey]);

  // cor de destaque da paleta na rota escolhida
  useEffect(() => {
    if (!map) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-eco').trim() || '#ff7a2f';
    const color = ['case', ['get', 'cleanest'], '#34d399', accent] as unknown as string;
    map.setPaintProperty('routes-main', 'line-color', color);
    map.setPaintProperty('routes-glow', 'line-color', color);
  }, [map, props.theme]);

  // rotas
  useEffect(() => {
    if (!map) return;
    (map.getSource('routes') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: props.routes.map((r, index) => ({
        type: 'Feature' as const,
        properties: { index, selected: r.selected, cleanest: r.cleanest },
        geometry: line(r.coords),
      })),
    });
  }, [map, props.routes]);

  // carregadores
  useEffect(() => {
    if (!map) return;
    (map.getSource('chargers') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: props.chargers.map((c) => ({ type: 'Feature' as const, properties: { name: c.name }, geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] } })),
    });
  }, [map, props.chargers]);

  // mapa de calor
  useEffect(() => {
    if (!map) return;
    (map.getSource('heat') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (props.heat ?? []).map((c) => ({ type: 'Feature' as const, properties: { mg: c.mg }, geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] } })),
    });
  }, [map, props.heat]);

  // colunas de emissão (altura proporcional ao PM2.5 por km do trecho)
  useEffect(() => {
    if (!map) return;
    // no replay (mapa afastado) as colunas crescem junto com o tamanho do percurso, para continuarem visíveis
    let radius = 7;
    if (!props.follow && props.columns.length > 1) {
      const lats = props.columns.map((c) => c.lat);
      const lngs = props.columns.map((c) => c.lng);
      const extentM = Math.hypot((Math.max(...lats) - Math.min(...lats)) * 111320, (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos((lats[0] * Math.PI) / 180));
      radius = Math.max(7, Math.min(80, extentM * 0.011));
    }
    (map.getSource('columns') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: props.columns.map((c) => ({
        type: 'Feature' as const,
        properties: { level: c.level, height: Math.max(radius * 0.6, Math.min(radius * 22, c.mgPerKm * radius * 0.75)) },
        geometry: { type: 'Polygon' as const, coordinates: [circleRing(c, radius, 12)] },
      })),
    });
  }, [map, props.columns, props.follow]);

  // ao terminar a viagem, enquadra o percurso inteiro para o replay 3D
  useEffect(() => {
    if (!map || props.follow || cb.current.columns.length < 2) return;
    const b = new LngLatBounds();
    cb.current.columns.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: cb.current.padding, pitch: 62, bearing: 25, duration: 1800, maxZoom: 16.5 });
  }, [map, props.follow]);

  // enquadra a rota escolhida
  const selected = props.routes.find((r) => r.selected);
  const selectedCoords = selected?.coords;
  useEffect(() => {
    if (!map || !selectedCoords?.length || cb.current.follow) return;
    const b = new LngLatBounds();
    selectedCoords.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: cb.current.padding, pitch: 52, bearing: -12, duration: 1400, maxZoom: 16 });
  }, [map, selectedCoords]);

  // marcadores de partida e destino
  useEffect(() => {
    if (!map) return;
    const set = (key: 'origin' | 'destination', p: Pt | null, color: string, label: string) => {
      markers.current[key]?.remove();
      markers.current[key] = p ? new Marker({ element: dotMarker(color, label), anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map) : undefined;
    };
    set('origin', props.origin, '#60a5fa', 'A');
    set('destination', props.destination, '#34d399', 'B');
    const only = props.origin && !props.destination ? props.origin : !props.origin && props.destination ? props.destination : null;
    if (only && !cb.current.follow) map.easeTo({ center: [only.lng, only.lat], zoom: 15.5, duration: 900 });
  }, [map, props.origin, props.destination]);

  // veículo ao vivo + rastro
  useEffect(() => {
    if (!map) return;
    (map.getSource('trail') as GeoJSONSource).setData(
      props.trail.length > 1 ? { type: 'Feature', properties: {}, geometry: line(props.trail) } : EMPTY,
    );
    if (!props.live) {
      markers.current.live?.remove();
      markers.current.live = undefined;
      return;
    }
    if (!markers.current.live) {
      const el = document.createElement('div');
      el.className = 'eco-car';
      markers.current.live = new Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([props.live.lng, props.live.lat]).addTo(map);
    }
    markers.current.live.setLngLat([props.live.lng, props.live.lat]).setRotation(props.live.heading);
    if (props.follow) {
      map.easeTo({ center: [props.live.lng, props.live.lat], bearing: props.live.heading, pitch: 66, zoom: 16.8, duration: 950, easing: (t) => t, padding: cb.current.padding });
    }
  }, [map, props.live, props.trail, props.follow]);

  const air: AirEmitter[] = [];
  if (props.live) {
    air.push({ lng: props.live.lng, lat: props.live.lat, rate: 12 + props.liveIntensity * 150, tone: props.liveLevel, spread: 4 });
  }
  const colTone = (l: string): AirTone => (l === 'high' ? 'high' : l === 'moderate' ? 'moderate' : 'low');
  for (const c of props.columns.slice(-140)) air.push({ lng: c.lng, lat: c.lat, rate: Math.min(5, c.mgPerKm * 0.35), tone: colTone(c.level) });
  if (props.heat) {
    for (const c of [...props.heat].sort((a, b) => b.mg - a.mg).slice(0, 160)) air.push({ lng: c.lng, lat: c.lat, rate: Math.min(4, 0.3 + c.mg * 0.4), tone: 'dust', spread: 40 });
  }
  if (props.routeHaze && !props.live) {
    const pts = props.routeHaze.coords;
    const step = Math.max(1, Math.floor(pts.length / 120));
    const rate = Math.min(3, props.routeHaze.mgPerKm * 0.22);
    for (let i = 0; i < pts.length; i += step) air.push({ lng: pts[i].lng, lat: pts[i].lat, rate, tone: 'dust', spread: 18 });
  }

  return (
    <div className="absolute inset-0">
      <div ref={container} className={`h-full w-full ${props.picking ? 'cursor-crosshair [&_canvas]:!cursor-crosshair' : ''}`} />
      {failed && (
        <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-mist">
          Este navegador não conseguiu iniciar o mapa 3D (WebGL desativado). O restante do EcoTire continua funcionando.
        </div>
      )}
      <AirOverlay map={map} emitters={air} lite={props.lite} />
      {/* vinheta para dar leitura aos painéis */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_60%,rgba(14,15,18,0.8)_100%)]" />
    </div>
  );
}
