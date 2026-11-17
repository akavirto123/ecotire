import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createStage, radialTexture, themeColor } from '@/components/stage3d';
import type { Vehicle } from '@/lib/vehicles';

/** Cor da pintura por veículo (o modelo 3D é o mesmo carro-conceito; muda a pintura). */
const PAINTS: Record<string, string> = {
  'ev-sedan': '#d9dde3',
  'ev-suv': '#1e63d6',
  hev: '#8d949e',
  phev: '#0e7c6b',
  pickup: '#1a1d23',
  'ice-compact': '#b3161b',
};
/** null = usar a cor de destaque do tema */
export const paintOf = (v: Vehicle): string | null => PAINTS[v.id] ?? null;

const DEFAULT_MODEL = `${import.meta.env.BASE_URL}models/car-concept.glb`;
const cache = new Map<string, Promise<GLTF>>();
function loadGlb(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<GLTF>((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(url, resolve, undefined, reject);
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

/**
 * Modelo por tipo de carroceria. Para ter um carro diferente por tipo, coloque um arquivo .glb em public/models
 * com um destes nomes: hatch.glb, sedan.glb, suv.glb, pickup.glb. Se o arquivo não existir, usa o carro-conceito.
 */
export type BodyType = 'hatch' | 'sedan' | 'suv' | 'pickup';
export function bodyTypeOf(v: Vehicle): BodyType {
  if (v.category === 'Utilitário') return 'pickup';
  if (v.id === 'ev-sedan') return 'sedan';
  if (v.curbWeightKg >= 1880) return 'suv';
  return v.curbWeightKg >= 1700 ? 'sedan' : 'hatch';
}
async function loadCar(body: BodyType): Promise<{ gltf: GLTF; custom: boolean }> {
  try {
    return { gltf: await loadGlb(`${import.meta.env.BASE_URL}models/${body}.glb`), custom: true };
  } catch {
    return { gltf: await loadGlb(DEFAULT_MODEL), custom: false }; // sem modelo para este tipo
  }
}

/**
 * Os modelos por tipo são feitos no Blender (tools/blender/build_cars.py) com materiais de nome fixo.
 * Aqui só a lataria ("Paint") recebe a cor do veículo; faróis e lanternas ganham brilho próprio.
 */
function repaint(car: THREE.Object3D, paint: THREE.Color) {
  car.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) {
      const sm = mm as THREE.MeshPhysicalMaterial;
      if (sm.name === 'Paint') {
        sm.color.copy(paint);
        sm.metalness = 0.45;
        sm.roughness = 0.3;
        sm.clearcoat = 1;
        sm.clearcoatRoughness = 0.08;
      } else if (sm.name === 'Glass') {
        sm.envMapIntensity = 1.6;
      } else if (sm.name === 'LightFront' || sm.name === 'LightRear') {
        sm.emissiveIntensity = 1.4;
      }
    }
  });
}

export function Car3D({ paint, body, theme, className }: { paint: string | null; body: BodyType; theme: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = createStage(el);
    if (!stage) {
      setStatus('error');
      return;
    }
    const { renderer, scene, camera, dispose } = stage;
    const accent = themeColor('--color-eco');
    camera.position.set(4.3, 1.75, 5.4);
    camera.lookAt(0, 0.5, 0);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 8, 5);
    const rim = new THREE.DirectionalLight(accent, 5);
    rim.position.set(-6, 2.5, -5);
    scene.add(key, rim);

    // palco: disco escuro brilhante, anéis de luz e sombra de contato
    const turntable = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(3.5, 3.6, 0.1, 96),
      new THREE.MeshStandardMaterial({ color: 0x121213, metalness: 0.2, roughness: 0.7 }),
    );
    disc.position.y = -0.05;
    const ringMat = new THREE.MeshBasicMaterial({ color: accent });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.52, 0.022, 8, 128), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.005;
    const ticks = new THREE.Group();
    for (let i = 0; i < 60; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(i % 5 ? 0.012 : 0.03, 0.004, i % 5 ? 0.12 : 0.24), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: i % 5 ? 0.35 : 0.9 }));
      const a = (i / 60) * Math.PI * 2;
      t.position.set(Math.cos(a) * 3.15, 0.006, Math.sin(a) * 3.15);
      t.rotation.y = -a + Math.PI / 2;
      ticks.add(t);
    }
    const shadowTex = radialTexture('rgba(0,0,0,0.85)');
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 3.6), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    const glowTex = radialTexture(`#${accent.getHexString()}`);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.008;
    turntable.add(disc, ring, ticks, glow);
    scene.add(turntable);

    const pivot = new THREE.Group();
    pivot.rotation.y = -0.65;
    pivot.add(shadow);
    scene.add(pivot);

    let alive = true;
    loadCar(body)
      .then(({ gltf, custom }) => {
        if (!alive) return;
        const car = gltf.scene.clone(true);
        const color = paint ? new THREE.Color(paint) : accent.clone();
        car.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
            const mat = (m as THREE.MeshPhysicalMaterial).clone();
            if (/^Paint 1/.test(mat.name)) {
              mat.color.copy(color);
              mat.metalness = 0.25;
              mat.roughness = 0.35;
              mat.clearcoat = 1;
              mat.clearcoatRoughness = 0.06;
            } else if (mat.name === 'License' || mat.name === 'Tireside') {
              // remove as texturas com logotipos de terceiros
              mat.map = null;
              mat.color.set(mat.name === 'License' ? 0x15171c : 0x0b0c0e);
            } else if (mat.name === 'Brake') {
              mat.color.copy(accent);
            }
            return mat;
          });
          mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
        });
        if (custom) {
          repaint(car, color);
          // modelo por tipo: centraliza, apoia no chão e ajusta para ~4,4 m de comprimento
          car.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(car, true);
          const size = box.getSize(new THREE.Vector3());
          const k = Math.min(1, 4.7 / Math.max(size.x, size.z, 0.001)); // modelos em metros; só a picape encolhe um pouco
          const c = box.getCenter(new THREE.Vector3());
          car.scale.setScalar(k);
          car.position.set(-c.x * k, -box.min.y * k, -c.z * k);
        } else {
          // o carro-conceito já vem apoiado no chão (y = 0); só centraliza no comprimento
          car.position.set(0, 0, -0.24);
        }
        const wrap = new THREE.Group();
        wrap.add(car);
        wrap.rotation.y = custom ? Math.PI / 2 : -Math.PI / 2; // modelos por tipo apontam para +z
        pivot.add(wrap);
        setStatus('ready');
      })
      .catch(() => alive && setStatus('error'));

    // arrastar para girar
    let dragX: number | null = null;
    let idleUntil = 0;
    const down = (e: PointerEvent) => {
      dragX = e.clientX;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (dragX == null) return;
      pivot.rotation.y += (e.clientX - dragX) * 0.012;
      dragX = e.clientX;
      idleUntil = performance.now() + 2500;
    };
    const up = () => {
      dragX = null;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.style.cursor = 'grab';
    el.style.touchAction = 'pan-y';

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduce) {
        if (dragX == null && now > idleUntil) pivot.rotation.y += dt * 0.3;
        ticks.rotation.y -= dt * 0.12;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      shadowTex.dispose();
      glowTex.dispose();
      dispose();
    };
  }, [paint, body, theme]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={host} className="h-full w-full" role="img" aria-label="Modelo 3D do veículo. Arraste para girar." />
      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-mist">
          {status === 'loading' ? 'Carregando modelo 3D…' : 'Não foi possível carregar o modelo 3D.'}
        </div>
      )}
    </div>
  );
}
