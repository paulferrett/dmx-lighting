// The on-screen rig: moving heads, beams in haze, the room they're in. It
// draws fixture state from the engine; everything it assumes about the
// physical heads (beam angle, travel speed, prism split) comes from the rig
// and only changes the picture.
//
// In rig mode it is also the rig editor: click a head or a room object, then
// move / rotate / resize it with three.js's TransformControls.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Fixture, FixtureState, FixtureType, Rig, RoomObject, Selection, Vec3 } from '@/types';

const DEG = Math.PI / 180;
const MAX_BEAM = 40;

export const CAMERAS: Record<string, { pos: Vec3; look: Vec3 }> = {
  front: { pos: [0, 1.7, 12.5], look: [0, 3.2, 0] },
  wide: { pos: [9, 6.5, 15], look: [0, 2.5, 2] },
  top: { pos: [0, 20, 5], look: [0, 0, 4.5] },
  side: { pos: [15, 3.5, 4], look: [0, 3, 3] },
  booth: { pos: [0, 2.2, -2.2], look: [0, 4, 8] },
};

// How each gobo shows up as streaks in a hazy beam: lobes around the axis.
const GOBO_LOOK: Record<string, { lobes: number; sharp: number; floor: number; width: number; rot?: number }> = {
  'open': { lobes: 0, sharp: 1, floor: 1, width: 1 },
  'small-circle': { lobes: 0, sharp: 1, floor: 1, width: 0.75 },
  'grid': { lobes: 4, sharp: 3, floor: 0.25, width: 1, rot: Math.PI / 4 },
  'star': { lobes: 5, sharp: 10, floor: 0.12, width: 1 },
  'flower8': { lobes: 8, sharp: 4, floor: 0.2, width: 1 },
  'cross': { lobes: 4, sharp: 14, floor: 0.06, width: 1 },
  'donut3': { lobes: 3, sharp: 1.5, floor: 0.05, width: 1 },
  'flower6': { lobes: 6, sharp: 4, floor: 0.2, width: 1 },
};

function goboTexture(name: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  g.translate(128, 128);
  const petals = (n: number, r: number, w: number) => {
    for (let i = 0; i < n; i++) { g.save(); g.rotate((i / n) * Math.PI * 2); g.beginPath(); g.ellipse(0, -r / 2, w, r / 2, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
  };
  switch (name) {
    case 'small-circle': g.beginPath(); g.arc(0, 0, 80, 0, Math.PI * 2); g.fill(); break;
    case 'grid': for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.fillRect(x > 0 ? 8 : -82, y > 0 ? 8 : -82, 74, 74); break;
    case 'star':
      g.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 42 : 118; const a = (i / 10) * Math.PI * 2 - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath(); g.fill(); break;
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

function makeBeamMesh(halfAngle: number) {
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
  mesh.raycast = () => {}; // beams are light, not things to click
  return mesh;
}

function seeded(seed: number) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

interface FixtureView {
  def: Fixture; type: FixtureType;
  root: THREE.Group; yoke: THREE.Group; head: THREE.Group; lens: THREE.Mesh;
  beams: THREE.Group; main: THREE.Mesh; prismRing: THREE.Group; facets: THREE.Mesh[];
  spot: THREE.SpotLight; stand?: THREE.Mesh;
  pan: number; tilt: number;
}

interface ObjectView { def: RoomObject; group: THREE.Group; body: THREE.Mesh }

export interface StageCallbacks {
  /** Something was clicked in rig mode. */
  onPick?: (sel: Selection) => void;
  /** A head or room object was moved with the handles; done is true on release. */
  onEdit?: (sel: Selection, change: { position: Vec3; rotation?: Vec3 | number; size?: Vec3 }, done: boolean) => void;
}

export class Stage {
  container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  controls: OrbitControls;
  transform: TransformControls;
  composer: EffectComposer;
  rig!: Rig;
  callbacks: StageCallbacks;
  fixtures = new Map<string, FixtureView>();
  objects = new Map<string, ObjectView>();
  room = new THREE.Group();
  solids: THREE.Object3D[] = [];
  gobos: Record<string, THREE.Texture> = {};
  editing = false;
  selection: Selection = { kind: 'none' };
  selectionBox = new THREE.BoxHelper(new THREE.Object3D(), '#ffcf4a');
  dragging = false;
  pendingRig: Rig | null = null;
  ray = new THREE.Raycaster();

  constructor(container: HTMLElement, rig: Rig, callbacks: StageCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.background = new THREE.Color('#040407');
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.setCamera('front');

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener('dragging-changed', (e: any) => {
      this.controls.enabled = !e.value;
      this.dragging = e.value;
      if (!e.value) {
        this.emitEdit(true);
        if (this.pendingRig) { const r = this.pendingRig; this.pendingRig = null; this.setRig(r); }
      }
    });
    this.transform.addEventListener('objectChange', () => this.emitEdit(false));
    this.scene.add(this.transform.getHelper());
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.55, 0.05));
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight('#aab2ff', '#2a2010', 0.7));
    const fill = new THREE.DirectionalLight('#c8ccff', 0.35);
    fill.position.set(3, 6, 12);
    this.scene.add(fill);
    this.scene.add(this.room);

    this.bindPicking();
    this.setRig(rig);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ---------------------------------------------------------------- building

  gobo(name: string) { return (this.gobos[name] ??= goboTexture(name)); }

  setRig(rig: Rig) {
    if (this.dragging) { this.pendingRig = rig; return; }
    this.rig = rig;
    this.buildRoom();
    this.buildFixtures();
    this.select(this.selection);
  }

  buildRoom() {
    this.room.clear();
    this.objects.clear();
    this.solids = [];
    const room = this.rig.room;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#34343c', roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.floor = true;
    this.room.add(floor);
    this.solids.push(floor);
    const grid = new THREE.GridHelper(40, 40, '#2b2b3a', '#1b1b24');
    grid.position.y = 0.002;
    grid.raycast = () => {};
    this.room.add(grid);

    if (room.ceiling) {
      const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#1e1e24', roughness: 0.9, side: THREE.DoubleSide }));
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.y = room.ceiling;
      ceiling.receiveShadow = true;
      ceiling.userData.ceiling = true;
      this.room.add(ceiling);
      this.solids.push(ceiling);
    }

    for (const o of room.objects) {
      const group = new THREE.Group();
      group.position.set(...o.position);
      group.rotation.y = (o.rotation ?? 0) * DEG;
      group.userData.objectId = o.id;
      let body: THREE.Mesh;
      if (o.kind === 'zone') {
        const geo = new THREE.PlaneGeometry(1, 1);
        geo.rotateX(-Math.PI / 2);
        body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#2d6cdf', transparent: true, opacity: 0.12, depthWrite: false }));
        body.scale.set(o.size[0], 1, o.size[2]);
        body.position.y = 0.01;
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#3d7cff', transparent: true, opacity: 0.5 }));
        edge.scale.copy(body.scale); edge.position.y = 0.012; edge.raycast = () => {};
        group.add(edge);
        this.addCrowd(group, o);
      } else {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        geo.translate(0, 0.5, 0);
        body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: o.kind === 'wall' ? '#24242b' : '#1b1b21', roughness: 0.85 }));
        body.scale.set(...o.size);
        body.castShadow = body.receiveShadow = true;
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#3a3a48' }));
        edge.scale.copy(body.scale); edge.raycast = () => {};
        group.add(edge);
        this.solids.push(body);
      }
      body.userData.objectId = o.id;
      group.add(body);
      this.room.add(group);
      this.objects.set(o.id, { def: o, group, body });
    }
  }

  addCrowd(group: THREE.Group, zone: RoomObject) {
    const count = zone.crowd ?? 0;
    if (!count) return;
    const rand = seeded(42);
    const people = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.21, 1.15, 4, 12), new THREE.MeshStandardMaterial({ color: '#4a4a56', roughness: 0.8 }), count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const h = 0.92 + rand() * 0.12;
      m.compose(new THREE.Vector3((rand() - 0.5) * zone.size[0], 0.8 * h, (rand() - 0.5) * zone.size[2]), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      people.setMatrixAt(i, m);
    }
    people.castShadow = people.receiveShadow = true;
    people.raycast = () => {};
    group.add(people);
  }

  buildFixtures() {
    for (const f of this.fixtures.values()) { this.scene.remove(f.root); if (f.stand) this.scene.remove(f.stand); }
    this.fixtures.clear();
    const metal = new THREE.MeshStandardMaterial({ color: '#3a3a46', metalness: 0.5, roughness: 0.45 });
    for (const fx of this.rig.fixtures) {
      const type = this.rig.fixtureTypes[fx.type];
      const root = new THREE.Group();
      root.userData.fixtureId = fx.id;
      this.scene.add(root);

      const tag = (o: THREE.Object3D) => { o.userData.fixtureId = fx.id; return o; };
      const base = tag(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.28), metal)) as THREE.Mesh;
      base.position.y = 0.06;
      base.castShadow = true;
      root.add(base);
      // a small arrow on the base showing which way pan 0 faces
      const nose = tag(new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 12), new THREE.MeshBasicMaterial({ color: '#5ed6ff' })));
      nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.06, 0.17);
      root.add(nose);
      const yoke = new THREE.Group();
      yoke.position.y = 0.12;
      root.add(yoke);
      for (const x of [-0.16, 0.16]) {
        const arm = tag(new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.3, 0.09), metal));
        arm.position.set(x, 0.15, 0);
        yoke.add(arm);
      }
      const bar = tag(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.09), metal));
      bar.position.y = 0.017;
      yoke.add(bar);
      const head = new THREE.Group();
      head.position.y = 0.2;
      yoke.add(head);
      const body = tag(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.27, 24), metal)) as THREE.Mesh;
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
      const facets: THREE.Mesh[] = [];
      const prismRing = new THREE.Group();
      beams.add(prismRing);
      const n = type.prism?.facets ?? 3;
      for (let i = 0; i < n; i++) {
        const holder = new THREE.Group();
        holder.rotation.y = (i / n) * Math.PI * 2;
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

      const view: FixtureView = { def: fx, type, root, yoke, head, lens, beams, main, prismRing, facets, spot, pan: this.rig.home?.pan ?? 0, tilt: this.rig.home?.tilt ?? 0 };
      this.fixtures.set(fx.id, view);
      this.placeFixture(view);
    }
  }

  // A stand under a head that sits upright off the floor.
  placeFixture(view: FixtureView) {
    const fx = view.def;
    view.root.position.set(...fx.position);
    view.root.rotation.set(fx.rotation[0] * DEG, fx.rotation[1] * DEG, fx.rotation[2] * DEG, 'XYZ');
    if (view.stand) { this.scene.remove(view.stand); view.stand = undefined; }
    const upright = Math.abs(fx.rotation[0]) < 1 && Math.abs(fx.rotation[2]) < 1;
    if (upright && fx.position[1] > 0.05) {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, fx.position[1]), new THREE.MeshStandardMaterial({ color: '#3a3a46', metalness: 0.5, roughness: 0.45 }));
      stand.position.set(fx.position[0], fx.position[1] / 2, fx.position[2]);
      stand.raycast = () => {};
      this.scene.add(stand);
      view.stand = stand;
    }
  }

  // ---------------------------------------------------------------- editing

  setEditing(on: boolean, tool: 'translate' | 'rotate' | 'scale' = 'translate', snap = true) {
    this.editing = on;
    this.transform.setMode(tool);
    this.transform.setTranslationSnap(snap ? 0.05 : null);
    this.transform.setRotationSnap(snap ? 15 * DEG : null);
    this.transform.setScaleSnap(snap ? 0.05 : null);
    this.select(on ? this.selection : { kind: 'none' }, !on);
  }

  select(sel: Selection, keep = false) {
    if (!keep) this.selection = sel;
    this.transform.detach();
    this.selectionBox.visible = false;
    if (!this.editing) return;
    let target: THREE.Object3D | undefined;
    if (sel.kind === 'fixture') target = this.fixtures.get(sel.id)?.root;
    if (sel.kind === 'object') target = this.objects.get(sel.id)?.group;
    if (!target) return;
    const isObject = sel.kind === 'object';
    const mode = this.transform.getMode();
    // Room objects turn about y only and resize on the floor plane; a zone has no height.
    const zone = isObject && this.objects.get((sel as any).id)?.def.kind === 'zone';
    this.transform.showX = true; this.transform.showY = true; this.transform.showZ = true;
    if (isObject && mode === 'rotate') { this.transform.showX = false; this.transform.showZ = false; }
    if (zone && mode === 'scale') this.transform.showY = false;
    if (!isObject && mode === 'scale') return; // heads don't resize
    this.transform.attach(target);
    this.selectionBox.setFromObject(target);
    this.selectionBox.visible = true;
  }

  emitEdit(done: boolean) {
    const target = this.transform.object;
    if (!target || !this.callbacks.onEdit) return;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const position: Vec3 = [r3(target.position.x), r3(target.position.y), r3(target.position.z)];
    this.selectionBox.setFromObject(target);
    if (this.selection.kind === 'fixture') {
      const view = this.fixtures.get(this.selection.id)!;
      const e = target.rotation;
      const rotation: Vec3 = [r3(e.x / DEG), r3(e.y / DEG), r3(e.z / DEG)];
      view.def = { ...view.def, position, rotation };
      if (done) this.placeFixture(view);
      this.callbacks.onEdit(this.selection, { position, rotation }, done);
    } else if (this.selection.kind === 'object') {
      const view = this.objects.get(this.selection.id)!;
      const s = view.body.scale;
      const size: Vec3 = [r3(view.def.size[0] * target.scale.x), view.def.kind === 'zone' ? 0 : r3(view.def.size[1] * target.scale.y), r3(view.def.size[2] * target.scale.z)];
      void s;
      this.callbacks.onEdit(this.selection, { position, rotation: r3(target.rotation.y / DEG), size }, done);
    }
  }

  bindPicking() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!this.editing || !down || this.dragging) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // that was an orbit
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.camera);
      const pickables: THREE.Object3D[] = [];
      for (const f of this.fixtures.values()) pickables.push(f.root);
      for (const o of this.objects.values()) pickables.push(o.body);
      const hit = this.ray.intersectObjects(pickables, true).find((h) => h.object.userData.fixtureId || h.object.userData.objectId);
      const sel: Selection = !hit ? { kind: 'none' }
        : hit.object.userData.fixtureId ? { kind: 'fixture', id: hit.object.userData.fixtureId }
          : { kind: 'object', id: hit.object.userData.objectId };
      this.callbacks.onPick?.(sel);
    });
  }

  // ---------------------------------------------------------------- drawing

  setCamera(name: string) {
    const c = CAMERAS[name] ?? CAMERAS.front;
    this.camera.position.set(...c.pos);
    this.controls.target.set(...c.look);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  colourHex(type: FixtureType, s: FixtureState, t: number) {
    if (s.colourSpin > 0.001) return type.colours[Math.floor(t * (0.25 + 3 * s.colourSpin)) % type.colours.length].hex;
    return type.colours.find((c) => c.name === s.colour)?.hex ?? '#ffffff';
  }

  goboNow(type: FixtureType, s: FixtureState, t: number) {
    if (s.goboMode === 'scroll') return type.gobos[Math.floor(t * (0.3 + 3 * s.goboSpeed)) % type.gobos.length].name;
    return s.gobo;
  }

  // Distance along a beam to the first floor, wall, box or ceiling it meets.
  beamLength(origin: THREE.Vector3, dir: THREE.Vector3) {
    this.ray.set(origin, dir);
    this.ray.far = MAX_BEAM;
    const hit = this.ray.intersectObjects(this.solids, false)[0];
    return Math.max(0.05, hit ? hit.distance : MAX_BEAM);
  }

  update(states: Record<string, FixtureState>, t: number, { dt = 0, snap = false, blackout = false } = {}) {
    const haze = this.rig.room?.haze ?? 0.6;
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
        if ((t * (lo + (hi - lo) * s.strobe)) % 1 > 0.18) level = 0;
      }
      const colour = new THREE.Color(this.colourHex(f.type, s, t));
      const goboName = this.goboNow(f.type, s, t);
      const look = GOBO_LOOK[goboName] ?? GOBO_LOOK.open;
      let rot = look.rot ?? 0;
      if (s.goboMode === 'shake') rot += Math.sin(t * (6 + 20 * s.goboSpeed)) * 0.35;

      f.head.updateWorldMatrix(true, false);
      f.beams.updateWorldMatrix(true, false);
      f.beams.getWorldPosition(origin);
      dir.set(0, 1, 0).transformDirection(f.beams.matrixWorld);
      const L = level > 0.001 ? this.beamLength(origin, dir) : MAX_BEAM;

      const prism = s.prism !== 'off';
      f.main.visible = !prism && level > 0.001;
      f.prismRing.visible = prism && level > 0.001;
      if (prism) f.prismRing.rotation.y = s.prism === 'rotate' ? t * (0.3 + 4 * s.prismSpeed) : 0;
      const setBeam = (mesh: THREE.Mesh, k: number) => {
        const u = (mesh.material as THREE.ShaderMaterial).uniforms;
        u.uColor.value.copy(colour);
        u.uIntensity.value = level * (0.35 + 0.9 * haze) * k * look.width;
        u.uLength.value = L;
        u.uLobes.value = look.lobes; u.uSharp.value = look.sharp; u.uFloor.value = look.floor; u.uRot.value = rot;
        mesh.scale.set(L * look.width, L, L * look.width);
      };
      setBeam(f.main, 1);
      for (const b of f.facets) setBeam(b, 0.6);

      (f.lens.material as THREE.MeshBasicMaterial).color.copy(colour).multiplyScalar(level * 3);
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

  /** A still for Claude: render from a named camera and hand back a JPEG. */
  snapshot(cameraName: string | undefined, width = 1280, height = 720) {
    const saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), aspect: this.camera.aspect };
    const size = this.renderer.getSize(new THREE.Vector2());
    const helper = this.transform.getHelper();
    const helperWas = helper.visible, boxWas = this.selectionBox.visible;
    helper.visible = false; this.selectionBox.visible = false;
    if (cameraName) this.setCamera(cameraName);
    // Exactly width × height, whatever the screen's pixel ratio: on a Retina
    // display the image would otherwise come back twice the size asked for.
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.composer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.render();
    const image = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    helper.visible = helperWas; this.selectionBox.visible = boxWas;
    this.camera.position.copy(saved.pos);
    this.controls.target.copy(saved.target);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.renderer.setSize(size.x, size.y, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer.setSize(size.x, size.y);
    this.camera.aspect = saved.aspect;
    this.camera.updateProjectionMatrix();
    return image;
  }

  /** Screen positions for the HTML labels over heads and (in rig mode) room objects. */
  labelPositions() {
    const out: { id: string; text: string; x: number; y: number; kind: 'fixture' | 'object' }[] = [];
    const v = new THREE.Vector3();
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const push = (id: string, text: string, kind: 'fixture' | 'object') => {
      v.project(this.camera);
      if (v.z < 1 && v.z > -1) out.push({ id, text, kind, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h });
    };
    for (const [id, f] of this.fixtures) {
      f.root.getWorldPosition(v);
      v.y -= 0.2;
      push(id, id, 'fixture');
    }
    if (this.editing) {
      for (const [id, o] of this.objects) {
        o.group.getWorldPosition(v);
        v.y += o.def.kind === 'zone' ? 0.05 : o.def.size[1] + 0.15;
        push(id, o.def.label || id, 'object');
      }
    }
    return out;
  }

  dispose() {
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
