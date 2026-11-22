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

const N = 420;
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
    camera.position.set(2.2, 0.35, 5.2);
    camera.lookAt(1.0, -0.25, 0);

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

    // nuvem de partículas saindo da área de contato (atrás do pneu): cada ponto é um "puff" macio
    // que nasce pequeno, sobe, espalha e some. Mais agressividade e velocidade = mais puffs, maiores e mais vermelhos.
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const life = new Float32Array(N); // segundos restantes
    const maxLife = new Float32Array(N);
    const lifeRatio = new Float32Array(N).fill(-1); // 1 = acabou de nascer, 0 = sumindo, -1 = inativo
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(lifeRatio, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const pMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color() }, uScale: { value: 300 }, uSize: { value: 1 } },
      vertexShader: `
        attribute float aLife; attribute float aSeed;
        uniform float uScale; uniform float uSize;
        varying float vAlpha; varying float vSeed;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          if (aLife < 0.0) { gl_PointSize = 0.0; vAlpha = 0.0; return; }
          float age = 1.0 - aLife;
          float size = mix(0.10, 0.62, age) * uSize * (0.75 + aSeed * 0.5);
          gl_PointSize = size * uScale / -mv.z;
          vAlpha = smoothstep(0.0, 0.12, age) * aLife;
          vSeed = aSeed;
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vAlpha; varying float vSeed;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float soft = smoothstep(0.5, 0.0, d);
          vec3 c = mix(uColor, vec3(0.55, 0.53, 0.5), 0.35 * vSeed); // um pouco de cinza de borracha
          gl_FragColor = vec4(c, soft * soft * vAlpha * 0.62);
        }`,
    });
    const cloud = new THREE.Points(geo, pMat);
    cloud.frustumCulled = false;
    scene.add(cloud);

    const low = new THREE.Color(0x34d399);
    const mid = new THREE.Color(0xfbbf24);
    const high = new THREE.Color(0xfb7185);
    const tmp = new THREE.Color();
    const buf = new THREE.Vector2();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    let debt = 0;
    let clamp = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = Math.max(0, Math.min(1, live.current.intensity));
      const sp = Math.max(0, Math.min(1.2, live.current.speedKmh / 100));
      // nível de emissão ilustrativo: agressividade pesa mais que velocidade
      const e = Math.min(1, k * 0.75 + sp * 0.35);
      wheel.rotation.x += (reduce ? 0.3 : 0.8 + live.current.speedKmh / 14) * dt;
      // pinça de freio: não gira (é presa na suspensão), mas aperta o disco e esquenta quando a condução fica agressiva
      clamp += ((k > 0.45 ? 1 : 0) - clamp) * Math.min(1, dt * 6);
      fixed.position.x = -0.006 * clamp;
      for (const m of brakeMats) {
        m.emissive.copy(accent);
        m.emissiveIntensity = 0.15 + clamp * (1.6 + 0.5 * Math.sin(now / 90));
      }
      tmp.copy(e < 0.5 ? low : mid).lerp(e < 0.5 ? mid : high, e < 0.5 ? e * 2 : (e - 0.5) * 2);
      pMat.uniforms.uColor.value.copy(tmp);
      pMat.uniforms.uSize.value = 0.7 + e * 0.9;
      // telas estreitas (celular): afasta a câmera para caber o pneu e a nuvem
      const back = camera.aspect < 1.6 ? Math.pow(1.6 / camera.aspect, 0.85) : 1;
      camera.position.set(2.2 * back, 0.35, 5.2 * back);
      camera.lookAt(1.0, -0.25, 0);
      renderer.getDrawingBufferSize(buf);
      pMat.uniforms.uScale.value = buf.y / (2 * Math.tan((camera.fov * Math.PI) / 360));

      debt += (reduce ? 8 : 12 + e * e * 150) * dt;
      for (let i = 0; i < N; i++) {
        if (life[i] > 0) {
          life[i] -= dt;
          vel[i * 3] *= 1 - 0.9 * dt; // o ar freia a poeira
          vel[i * 3 + 1] += 0.35 * dt; // e ela sobe devagar
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          lifeRatio[i] = life[i] > 0 ? life[i] / maxLife[i] : -1;
        } else if (debt >= 1) {
          debt -= 1;
          maxLife[i] = life[i] = 1.2 + Math.random() * 1.6;
          lifeRatio[i] = 1;
          pos[i * 3] = 0.25 + Math.random() * 0.25;
          pos[i * 3 + 1] = -1.02 + Math.random() * 0.08;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
          vel[i * 3] = 0.5 + Math.random() * (0.6 + e * 2.2);
          vel[i * 3 + 1] = 0.05 + Math.random() * (0.25 + e * 0.35);
          vel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
        }
      }
      if (debt > 40) debt = 40;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLife.needsUpdate = true;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      shadowTex.dispose();
      dispose();
    };
  }, [theme]);

  return <div ref={host} className={className} aria-hidden="true" />;
}
