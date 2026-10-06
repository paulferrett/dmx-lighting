// The on-screen rig: moving heads on stands, beams in haze, gobo patterns on
// whatever they hit, a crowd for scale. It draws fixture state from the
// engine; everything it assumes about the physical heads (beam angle, travel
// speed, prism split) comes from rig.json and only changes the picture.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DEG = Math.PI / 180;
const WALL_Z = -2.5;
const MAX_BEAM = 40;

export const CAMERAS = {
  front: { pos: [0, 1.7, 12.5], look: [0, 3.2, 0] },
  wide: { pos: [9, 6.5, 15], look: [0, 2.5, 2] },
  top: { pos: [0, 20, 5], look: [0, 0, 4.5] },
  side: { pos: [15, 3.5, 4], look: [0, 3, 3] },
  booth: { pos: [0, 2.2, -2.2], look: [0, 4, 8] },
};

// How each gobo shows up as streaks in a hazy beam: lobes around the axis.
const GOBO_LOOK = {
  'open': { lobes: 0, sharp: 1, floor: 1, width: 1 },
  'small-circle': { lobes: 0, sharp: 1, floor: 1, width: 0.75 },
  'grid': { lobes: 4, sharp: 3, floor: 0.25, width: 1, rot: Math.PI / 4 },
  'star': { lobes: 5, sharp: 10, floor: 0.12, width: 1 },
  'flower8': { lobes: 8, sharp: 4, floor: 0.2, width: 1 },
  'cross': { lobes: 4, sharp: 14, floor: 0.06, width: 1 },
  'donut3': { lobes: 3, sharp: 1.5, floor: 0.05, width: 1 },
  'flower6': { lobes: 6, sharp: 4, floor: 0.2, width: 1 },
};

function goboTexture(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  g.translate(128, 128);
  const petals = (n, r, w) => { for (let i = 0; i < n; i++) { g.save(); g.rotate((i / n) * Math.PI * 2); g.beginPath(); g.ellipse(0, -r / 2, w, r / 2, 0, 0, Math.PI * 2); g.fill(); g.restore(); } };
  switch (name) {
    case 'small-circle': g.beginPath(); g.arc(0, 0, 80, 0, Math.PI * 2); g.fill(); break;
    case 'grid': for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.fillRect(x > 0 ? 8 : -82, y > 0 ? 8 : -82, 74, 74); break;
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 42 : 118; const a = (i / 10) * Math.PI * 2 - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath(); g.fill(); break;
    }
    case 'flower8': petals(8, 116, 26); break;
    case 'cross': g.fillRect(-18, -118, 36, 236); g.fillRect(-118, -18, 236, 36); break;
    case 'donut3':
      g.lineWidth = 34; g.strokeStyle = '#fff';
      for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(0, 0, 90, (i / 3) * Math.PI * 2 + 0.2, ((i + 1) / 3) * Math.PI * 2 - 0.2); g.stroke(); }
      break;
    case 'flower6': petals(6, 116, 32); break;
    default: g.beginPath(); g.arc(0, 0, 118, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const beamVertex = /* glsl */`
  varying float vAlong;
  varying float vAngle;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vAlong = position.y;
    vAngle = atan(position.x, position.z);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const beamFragment = /* glsl */`
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uLength;
  uniform float uLobes;
  uniform float uSharp;
  uniform float uFloor;
  uniform float uRot;
  varying float vAlong;
  varying float vAngle;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float along = clamp(vAlong, 0.0, 1.0);
    float dist = along * uLength;
    float falloff = pow(1.0 - along, 1.3) / (1.0 + dist * 0.06);
    float core = exp(-dist * 1.6) * 0.8;
    float edge = pow(abs(dot(vNormal, vView)), 1.6);
    float pattern = 1.0;
    if (uLobes > 0.5) pattern = uFloor + (1.0 - uFloor) * pow(cos(uLobes * (vAngle - uRot)) * 0.5 + 0.5, uSharp);
    float a = uIntensity * (falloff * edge * pattern + core * edge);
    gl_FragColor = vec4(uColor * a, 1.0);
  }`;

function makeBeamMesh(halfAngle) {
  const geo = new THREE.CylinderGeometry(Math.tan(halfAngle), 0.0015, 1, 48, 1, true);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: beamVertex,
    fragmentShader: beamFragment,
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uIntensity: { value: 0 },
      uLength: { value: 20 },
      uLobes: { value: 0 }, uSharp: { value: 1 }, uFloor: { value: 1 }, uRot: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// Seeded so the crowd stands in the same place in every snapshot.
function seeded(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

export class Stage {
  constructor(container, rig) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#040407');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.setCamera('front');

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.55, 0.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.gobos = {};
    this.fixtures = new Map();
    this.buildRoom();
    this.setRig(rig);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  buildRoom() {
    // Enough house light to see the heads and the room; the beams do the rest.
    this.scene.add(new THREE.HemisphereLight('#aab2ff', '#2a2010', 0.7));
    const fill = new THREE.DirectionalLight('#c8ccff', 0.35);
    fill.position.set(3, 6, 12);
    this.scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#34343c', roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(30, 30, '#2b2b3a', '#18181f');
    grid.position.y = 0.002;
    this.scene.add(grid);
    this.wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshStandardMaterial({ color: '#202026', roughness: 0.9 }));
    this.wall.position.set(0, 5, WALL_Z);
    this.wall.receiveShadow = true;
    this.scene.add(this.wall);

    const booth = new THREE.Mesh(new THREE.BoxGeometry(2, 1.05, 0.8), new THREE.MeshStandardMaterial({ color: '#16161b', roughness: 0.6 }));
    booth.position.set(0, 0.525, -1.1);
    booth.castShadow = booth.receiveShadow = true;
    this.scene.add(booth);

    const rand = seeded(42);
    const people = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.21, 1.15, 4, 12), new THREE.MeshStandardMaterial({ color: '#4a4a56', roughness: 0.8 }), 46);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 46; i++) {
      const h = 0.92 + rand() * 0.12;
      m.compose(new THREE.Vector3(-4.6 + rand() * 9.2, 0.8 * h, 3 + rand() * 6.5), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      people.setMatrixAt(i, m);
    }
    people.castShadow = people.receiveShadow = true;
    this.scene.add(people);
  }

  gobo(name) { return (this.gobos[name] ??= goboTexture(name)); }

  setRig(rig) {
    this.rig = rig;
    for (const f of this.fixtures.values()) this.scene.remove(f.root);
    this.fixtures.clear();
    this.wall.visible = rig.stage?.wall !== false;
    const metal = new THREE.MeshStandardMaterial({ color: '#3a3a46', metalness: 0.5, roughness: 0.45 });
    for (const fx of rig.fixtures) {
      const type = rig.fixtureTypes[fx.type];
      const root = new THREE.Group();
      root.position.set(...fx.position);
      root.rotation.set(0, (fx.yaw ?? 0) * DEG, fx.mount === 'hung' ? Math.PI : 0);
      this.scene.add(root);

      if (fx.mount !== 'hung' && fx.position[1] > 0.05) {
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, fx.position[1]), metal);
        stand.position.set(fx.position[0], fx.position[1] / 2, fx.position[2]);
        this.scene.add(stand);
        root.userData.stand = stand;
      }

      const base = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.28), metal);
      base.position.y = 0.06;
      base.castShadow = true;
      root.add(base);
      const yoke = new THREE.Group();
      yoke.position.y = 0.12;
      root.add(yoke);
      for (const x of [-0.16, 0.16]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.3, 0.09), metal);
        arm.position.set(x, 0.15, 0);
        yoke.add(arm);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.09), metal);
      bar.position.y = 0.017;
      yoke.add(bar);
      const head = new THREE.Group();
      head.position.y = 0.2;
      yoke.add(head);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.27, 24), metal);
      body.castShadow = true;
      head.add(body);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), new THREE.MeshBasicMaterial({ color: '#000', toneMapped: false }));
      lens.rotation.x = -Math.PI / 2;
      lens.position.y = 0.136;
      head.add(lens);

      const half = (type.beamAngle ?? 4) / 2 * DEG;
      const beams = new THREE.Group();
      beams.position.y = 0.14;
      head.add(beams);
      const main = makeBeamMesh(half);
      beams.add(main);
      const facets = [];
      const prismRing = new THREE.Group();
      beams.add(prismRing);
      for (let i = 0; i < (type.prism?.facets ?? 3); i++) {
        const holder = new THREE.Group();
        holder.rotation.y = (i / (type.prism?.facets ?? 3)) * Math.PI * 2;
        const b = makeBeamMesh(half);
        b.rotation.x = 3.5 * DEG;
        holder.add(b);
        prismRing.add(holder);
        facets.push(b);
      }

      const spot = new THREE.SpotLight('#fff', 0, MAX_BEAM, half * 1.25, 0.35, 1.1);
      spot.position.set(0, 0.14, 0);
      spot.castShadow = true;
      spot.shadow.mapSize.set(512, 512);
      spot.shadow.camera.near = 0.2;
      spot.map = this.gobo('open');
      const aimAt = new THREE.Object3D();
      aimAt.position.set(0, 5, 0);
      head.add(spot, aimAt);
      spot.target = aimAt;

      this.fixtures.set(fx.id, {
        def: fx, type, root, yoke, head, lens, beams, main, prismRing, facets, spot,
        pan: rig.home?.pan ?? 0, tilt: rig.home?.tilt ?? 0,
      });
    }
  }

  setCamera(name) {
    const c = CAMERAS[name] ?? CAMERAS.front;
    this.camera.position.set(...c.pos);
    this.controls.target.set(...c.look);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  colourHex(type, s, t) {
    if (s.colourSpin > 0.001) {
      const list = type.colours;
      return list[Math.floor(t * (0.25 + 3 * s.colourSpin)) % list.length].hex;
    }
    return type.colours.find((c) => c.name === s.colour)?.hex ?? '#ffffff';
  }

  goboNow(type, s, t) {
    if (s.goboMode === 'scroll') return type.gobos[Math.floor(t * (0.3 + 3 * s.goboSpeed)) % type.gobos.length].name;
    return s.gobo;
  }

  // Distance along a beam before it hits the floor or the back wall.
  beamLength(origin, dir) {
    let L = MAX_BEAM;
    if (dir.y < -1e-4) L = Math.min(L, -origin.y / dir.y);
    if (this.wall.visible && dir.z < -1e-4) {
      const d = (WALL_Z - origin.z) / dir.z;
      const hitY = origin.y + dir.y * d;
      if (hitY >= 0 && hitY <= 10) L = Math.min(L, d);
    }
    return Math.max(0.05, L);
  }

  // states: engine output per fixture. dt: seconds since the last frame, used
  // to move the heads no faster than the motors can. snap: jump straight there
  // (on a seek, or for a still).
  update(states, t, { dt = 0, snap = false, blackout = false } = {}) {
    const haze = this.rig.stage?.haze ?? 0.6;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (const [id, f] of this.fixtures) {
      const s = states[id];
      if (!s) continue;
      if (snap) { f.pan = s.pan; f.tilt = s.tilt; }
      else {
        const slow = 1 - 0.97 * Math.min(1, s.crawl);
        const stepP = (f.type.panSpeed ?? 220) * slow * dt;
        const stepT = (f.type.tiltSpeed ?? 160) * slow * dt;
        f.pan += Math.max(-stepP, Math.min(stepP, s.pan - f.pan));
        f.tilt += Math.max(-stepT, Math.min(stepT, s.tilt - f.tilt));
      }
      f.yoke.rotation.y = f.pan * DEG;
      f.head.rotation.x = f.tilt * DEG;

      let level = blackout ? 0 : s.dimmer;
      if (s.strobe > 0.001) {
        const [lo, hi] = f.type.strobeHz ?? [0.5, 20];
        const hz = lo + (hi - lo) * s.strobe;
        if ((t * hz) % 1 > 0.18) level = 0;
      }
      const colour = new THREE.Color(this.colourHex(f.type, s, t));
      const goboName = this.goboNow(f.type, s, t);
      const look = GOBO_LOOK[goboName] ?? GOBO_LOOK.open;
      let rot = (look.rot ?? 0);
      if (s.goboMode === 'shake') rot += Math.sin(t * (6 + 20 * s.goboSpeed)) * 0.35;

      f.head.updateWorldMatrix(true, false);
      f.beams.getWorldPosition(origin);
      dir.set(0, 1, 0).transformDirection(f.beams.matrixWorld);
      const L = this.beamLength(origin, dir);

      const prism = s.prism !== 'off';
      f.main.visible = !prism && level > 0.001;
      f.prismRing.visible = prism && level > 0.001;
      if (prism) f.prismRing.rotation.y = s.prism === 'rotate' ? t * (0.3 + 4 * s.prismSpeed) : 0;
      const setBeam = (mesh, k) => {
        const u = mesh.material.uniforms;
        u.uColor.value.copy(colour);
        u.uIntensity.value = level * (0.35 + 0.9 * haze) * k * look.width;
        u.uLength.value = L;
        u.uLobes.value = look.lobes; u.uSharp.value = look.sharp; u.uFloor.value = look.floor; u.uRot.value = rot;
        mesh.scale.set(L * look.width, L, L * look.width);
      };
      setBeam(f.main, 1);
      for (const b of f.facets) setBeam(b, 0.6);

      f.lens.material.color.copy(colour).multiplyScalar(level * 3);
      f.spot.color.copy(colour);
      f.spot.intensity = level * 900;
      f.spot.map = this.gobo(goboName);
      f.spot.angle = (f.type.beamAngle ?? 4) / 2 * DEG * 1.25 * (prism ? 3 : 1) * look.width;
    }
  }

  render() {
    this.controls.update();
    this.composer.render();
  }

  // A still for Claude: render from a named camera and hand back a JPEG.
  snapshot(cameraName, width = 1280, height = 720) {
    const saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), aspect: this.camera.aspect };
    const size = this.renderer.getSize(new THREE.Vector2());
    if (cameraName) this.setCamera(cameraName);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.render();
    const image = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    this.camera.position.copy(saved.pos);
    this.controls.target.copy(saved.target);
    this.renderer.setSize(size.x, size.y, false);
    this.composer.setSize(size.x, size.y);
    this.camera.aspect = saved.aspect;
    this.camera.updateProjectionMatrix();
    return image;
  }

  // Screen position of each head, for labels.
  labelPositions() {
    const out = {};
    const v = new THREE.Vector3();
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const [id, f] of this.fixtures) {
      f.root.getWorldPosition(v);
      v.y -= f.def.mount === 'hung' ? -0.25 : 0.2;
      v.project(this.camera);
      out[id] = { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
    }
    return out;
  }
}
