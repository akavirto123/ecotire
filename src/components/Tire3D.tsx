import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createStage, radialTexture, themeColor } from '@/components/stage3d';

type Props = {
  /** 0 = condução suave (poucas partículas), 1 = agressiva (muitas, vermelhas) */
  intensity: number;
  speedKmh?: number;
  theme?: string;
  className?: string;
};

const N = 480;
const WHEEL_CENTER = new THREE.Vector3(0.975, 0.384, 1.485);

let cached: Promise<GLTF> | null = null;
function loadWheel(): Promise<GLTF> {
  cached ??= new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(`${import.meta.env.BASE_URL}models/wheel.glb`, resolve, undefined, (e) => {
      cached = null;
      reject(e);
    });
  });
  return cached;
}

/** Roda realista em 3D soltando partículas conforme a emissão. Modelo: "Car Concept" (Khronos Group / Unity Fan), CC BY 4.0. */
export function Tire3D({ intensity, speedKmh = 40, theme = '', className }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ intensity, speedKmh });
  live.current = { intensity, speedKmh };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = createStage(el);
    if (!stage) return;
    const { renderer, scene, camera, dispose } = stage;
    const accent = themeColor('--color-eco');
    camera.position.set(2.5, 0.45, 4.3);
    camera.lookAt(0.5, -0.12, 0);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 4, 5);
    const rimLight = new THREE.DirectionalLight(accent, 4);
    rimLight.position.set(-4, 1, -3);
    scene.add(key, rimLight);

    // roda realista (pneu com banda de rodagem, aro de liga, disco e pinça), extraída do modelo "Car Concept"
    const wheel = new THREE.Group(); // gira: pneu, aro e disco
    const fixed = new THREE.Group(); // não gira: pinça de freio
    const rig = new THREE.Group();
    rig.add(wheel, fixed);
    rig.rotation.y = -Math.PI / 2 + 0.12; // face externa da roda voltada para a câmera
    rig.scale.setScalar(1.07 / 0.384);
    scene.add(rig);
    let alive = true;
    const brakeMats: THREE.MeshStandardMaterial[] = [];
    loadWheel()
      .then((gltf) => {
        if (!alive) return;
        const model = gltf.scene.clone(true);
        model.updateMatrixWorld(true);
        // a roda veio do carro esterçada ~30°: usamos o referencial do próprio cubo (eixo = x local) para girar sem bambolear
        const hub = model.getObjectByName('WheelFrontL');
        const toHub = new THREE.Matrix4();
        if (hub) toHub.copy(hub.matrixWorld).invert();
        const parts: THREE.Mesh[] = [];
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh);
        });
        for (const mesh of parts) {
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
            const mat = (m as THREE.MeshStandardMaterial).clone();
            if (mat.name === 'Tireside') {
              mat.map = null; // textura com logotipo de terceiros
              mat.color.set(0x0d0d0e);
            } else if (mat.name === 'Brake') {
              mat.color.copy(accent);
              brakeMats.push(mat);
            }
            return mat;
          });
          mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
          // leva cada peça para o centro da roda (eixo em x), preservando a transformação original
          if (hub) {
            mesh.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
            mesh.applyMatrix4(toHub);
          } else {
            mesh.applyMatrix4(new THREE.Matrix4().copy(mesh.parent!.matrixWorld));
            mesh.position.sub(WHEEL_CENTER);
          }
          (/BrakePad/.test(mesh.name) || /BrakePad/.test(mesh.parent?.name ?? '') ? fixed : wheel).add(mesh);
        }
      })
      .catch(() => undefined);

    // chão: sombra de contato e reflexo de luz
    const shadowTex = radialTexture('rgba(0,0,0,0.8)');
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.5), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0.15, -1.085, 0);
    scene.add(shadow);

    // partículas macias saindo da área de contato
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const life = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = -99;
    const dotTex = radialTexture('rgba(255,255,255,1)');
    const pMat = new THREE.PointsMaterial({ map: dotTex, size: 0.11, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    scene.add(new THREE.Points(geo, pMat));

    const low = new THREE.Color(0x34d399);
    const mid = new THREE.Color(0xfbbf24);
    const high = new THREE.Color(0xfb7185);
    const tmp = new THREE.Color();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    let debt = 0;
    let clamp = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = Math.max(0, Math.min(1, live.current.intensity));
      wheel.rotation.x += (reduce ? 0.3 : 0.8 + live.current.speedKmh / 14) * dt;
      // pinça de freio: não gira (é presa na suspensão), mas aperta o disco e esquenta quando a condução fica agressiva
      clamp += ((k > 0.45 ? 1 : 0) - clamp) * Math.min(1, dt * 6);
      fixed.position.x = -0.006 * clamp;
      for (const m of brakeMats) {
        m.emissive.copy(accent);
        m.emissiveIntensity = 0.15 + clamp * (1.6 + 0.5 * Math.sin(now / 90));
      }
      tmp.copy(k < 0.5 ? low : mid).lerp(k < 0.5 ? mid : high, k < 0.5 ? k * 2 : (k - 0.5) * 2);
      pMat.color.copy(tmp);

      debt += (reduce ? 8 : 18 + k * 240) * dt;
      for (let i = 0; i < N; i++) {
        if (life[i] > 0) {
          life[i] -= dt;
          vel[i * 3 + 1] += 0.45 * dt;
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          if (life[i] <= 0) pos[i * 3 + 1] = -99;
        } else if (debt >= 1) {
          debt -= 1;
          life[i] = 0.9 + Math.random() * 1.4;
          pos[i * 3] = 0.1 + Math.random() * 0.2;
          pos[i * 3 + 1] = -1.07 + Math.random() * 0.06;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
          vel[i * 3] = 0.6 + Math.random() * (0.8 + k * 1.6);
          vel[i * 3 + 1] = Math.random() * 0.3;
          vel[i * 3 + 2] = (Math.random() - 0.5) * 0.45;
        }
      }
      if (debt > 40) debt = 40;
      geo.attributes.position.needsUpdate = true;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      shadowTex.dispose();
      dotTex.dispose();
      dispose();
    };
  }, [theme]);

  return <div ref={host} className={className} aria-hidden="true" />;
}
