import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as CANNON from 'cannon-es';
import {
  ArenaEventPacket,
  BotArchetype,
  ClientInputPacket,
  FastDataPacket,
  FrozenMatchSummary,
  GameShellState,
  HudSnapshot,
  NetworkRole,
  PlayerSyncState,
  PropSyncState,
  ReliableDataPacket,
  ShardSyncState,
  SolarCoreSyncState,
  Vec3Tuple,
  WorldSnapshotPacket,
} from './types';
import {
  ARENA_RADIUS,
  calculateShockwaveImpulse,
  checkMatchEnd,
  computeBotIntent,
  createFrozenMatchSummary,
  evaluateGoalZone,
  evaluateRingOut,
  interpolatePeerTransform,
  MATCH_DURATION_SECONDS,
  PLAYER_PALETTE,
  shortestAngleDelta,
} from './rules';
import {
  buildSkyCitadelEnvironment,
  createStrikerVisualRig,
  EnvironmentHandles,
   getRadialShadowTexture,
  PooledParticleSystem,
  StrikerVisualRig,
} from './models';
import { arenaAudio } from './audio';

export const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

interface InternalActor {
  state: PlayerSyncState;
  body: CANNON.Body;
  visual: StrikerVisualRig;
  scaleSquashX: number;
  scaleSquashY: number;
  coyoteTimer: number;
  jumpBufferTimer: number;
  wasGrounded: boolean;
  travelPhase: number;
  koRespawnTimer: number;
}

interface InternalProp {
  id: string;
  kind: 'crate' | 'bumper';
  spawnPos: Vec3Tuple;
  body: CANNON.Body;
  mesh: THREE.Group;
  shadow: THREE.Mesh;
}

interface InternalShard {
  state: ShardSyncState;
  mesh: THREE.Group;
}

export interface NameplateDomHandle {
  id: string;
  name: string;
  colorHex: string;
  isBot: boolean;
  isLocal: boolean;
}

export interface ArenaEngineCallbacks {
  onHudUpdate: (hud: HudSnapshot) => void;
  onFeedEvent: (message: string, accentColor: string) => void;
  onMatchFinished: (summary: FrozenMatchSummary) => void;
  onNameplatesChanged: (items: NameplateDomHandle[]) => void;
  sendFastPacket: (packet: FastDataPacket) => void;
  sendReliablePacket: (packet: ReliableDataPacket) => void;
}

const SPAWN_POINTS: Vec3Tuple[] = [
  { x: 0, y: 1.5, z: 12.5 },
  { x: -10.5, y: 1.5, z: 8.5 },
  { x: 10.5, y: 1.5, z: 8.5 },
  { x: -10.5, y: 1.5, z: -8.5 },
  { x: 10.5, y: 1.5, z: -8.5 },
  { x: 0, y: 1.5, z: -12.5 },
];

const BOT_DEFS: Array<{ id: string; name: string; archetype: BotArchetype; color: string }> = [
  { id: 'bot-aegis', name: 'Aegis [Bot]', archetype: 'striker', color: '#059669' },
  { id: 'bot-vulcan', name: 'Vulcan [Bot]', archetype: 'rammer', color: '#dc2626' },
  { id: 'bot-orion', name: 'Orion [Bot]', archetype: 'warden', color: '#7c3aed' },
];

// Reusable module-level math objects (Zero GC inside render loop)
const _projVec = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _camLookTarget = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _cannonImpulse = new CANNON.Vec3();

export class ArenaEngine {
  private container: HTMLElement;
  private nameplateRefs: Map<string, HTMLDivElement>;
  private callbacks: ArenaEngineCallbacks;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private resizeObserver: ResizeObserver;
  private envHandles: EnvironmentHandles;
  private particles: PooledParticleSystem;

  private world: CANNON.World;
  private playerPhysMat: CANNON.Material;
  private groundPhysMat: CANNON.Material;
  private corePhysMat: CANNON.Material;

  private actors = new Map<string, InternalActor>();
  private props: InternalProp[] = [];
  private shards: InternalShard[] = [];

  private solarCoreBody!: CANNON.Body;
  private solarCoreGroup!: THREE.Group;
  private solarCoreRingA!: THREE.Mesh;
  private solarCoreRingB!: THREE.Mesh;
  private solarCoreShadow!: THREE.Mesh;
  private solarCoreLastTouchId: string | null = null;

  private shellState: GameShellState = 'title';
  private role: NetworkRole = 'offline';
  private localPlayerId = 'local-player';
  private localName = 'Nova';
  private localColor = PLAYER_PALETTE[0];
  private desiredBotCount = 2;

  private matchTimeRemaining = MATCH_DURATION_SECONDS;
  private matchElapsed = 0;
  private matchEnded = false;
  private seqCounter = 0;

  private frameId = 0;
  private lastPerfTime = performance.now();
  private hudSyncAccum = 0;
  private netSyncAccum = 0;
  private hitstopTimer = 0;
  private cameraTrauma = 0;
  private currentLookAt = new THREE.Vector3(0, 2.2, -4);

  // Unified input state (`held` + `justPressed` edge triggers)
  private keysHeld = new Set<string>();
  private keysJustPressed = new Set<string>();
  private pointerShockwaveQueued = false;
  private pendingNetDash = false;
  private pendingNetShockwave = false;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    nameplateRefs: Map<string, HTMLDivElement>,
    callbacks: ArenaEngineCallbacks
  ) {
    this.container = container;
    this.nameplateRefs = nameplateRefs;
    this.callbacks = callbacks;

    // 1. WebGLRenderer with Software-WebGL Guard & ACES Filmic Color Pipeline
    this.renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.shadowMap.enabled = !isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const rect = container.getBoundingClientRect();
    const initW = Math.max(320, rect.width || window.innerWidth);
    const initH = Math.max(240, rect.height || window.innerHeight);
    this.renderer.setSize(initW, initH);
    this.renderer.domElement.dataset.testid = 'arena-canvas';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // WebGL Context Loss Safety
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    });

    // 2. Scene, Rich Mediterranean Azure Sky & Matching Atmospheric Fog
    this.scene = new THREE.Scene();
    const horizonHex = 0x89bce8;
    this.scene.background = new THREE.Color(horizonHex);
    this.scene.fog = new THREE.FogExp2(horizonHex, 0.0068);

    // Studio Environment Reflections (RoomEnvironment PMREM on every device)
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(
      new RoomEnvironment(),
      0.04
    ).texture;
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(56, initW / initH, 0.25, 220);
    this.camera.position.set(0, 11.5, 25);
    this.camera.lookAt(0, 2, 0);

    // 3. Warm/Cool Color-Temperature Studio & Sun Rig (1 shadow caster max)
    const hemiLight = new THREE.HemisphereLight(0x8ecae6, 0xb07d4f, 0.92);
    hemiLight.position.set(0, 45, 0);
    this.scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff1d6, 2.15);
    sunLight.position.set(26, 40, 22);
    sunLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      sunLight.shadow.mapSize.set(1024, 1024);
      const d = 29;
      sunLight.shadow.camera.left = -d;
      sunLight.shadow.camera.right = d;
      sunLight.shadow.camera.top = d;
      sunLight.shadow.camera.bottom = -d;
      sunLight.shadow.camera.near = 4;
      sunLight.shadow.camera.far = 96;
      sunLight.shadow.bias = -0.0005;
      sunLight.shadow.normalBias = 0.02;
    }
    this.scene.add(sunLight);

    const rimLight = new THREE.DirectionalLight(0xfbbf24, 0.55);
    rimLight.position.set(-22, 16, -28);
    this.scene.add(rimLight);

    // 4. Environment, Pooled Particles & Cannon.js Physics World
    this.envHandles = buildSkyCitadelEnvironment(
      this.scene,
      this.renderer,
      !isSoftwareGl
    );
    this.particles = new PooledParticleSystem(this.scene);

    this.world = new CANNON.World();
    this.world.gravity.set(0, -24, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    this.groundPhysMat = new CANNON.Material('ground');
    this.playerPhysMat = new CANNON.Material('player');
    this.corePhysMat = new CANNON.Material('core');

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.groundPhysMat, this.playerPhysMat, {
        friction: 0.02,
        restitution: 0.0,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.groundPhysMat, this.corePhysMat, {
        friction: 0.25,
        restitution: 0.72,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.playerPhysMat, this.corePhysMat, {
        friction: 0.1,
        restitution: 0.85,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.playerPhysMat, this.playerPhysMat, {
        friction: 0.05,
        restitution: 0.65,
      })
    );

    this.initStaticArenaColliders();
    this.initSolarCore();
    this.initDynamicProps();
    this.initRadiantShards();
    this.rebuildRoster(this.localPlayerId, this.localName, this.localColor, 2);

    if (!isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // 5. ResizeObserver & Input Listeners
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, entry.contentRect.width);
        const h = Math.max(240, entry.contentRect.height);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
      }
    });
    this.resizeObserver.observe(container);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearHeldInputs);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);

    // Render immediate first frame so canvas is populated at t = 0ms even on software WebGL
    this.syncVisualMeshesAndCamera(0.016, 0);
    this.renderer.render(this.scene, this.camera);

    this.lastPerfTime = performance.now();
    this.scheduleNextTick();
  }

  private initStaticArenaColliders(): void {
    // Octagonal Plaza Deck Collider (top at Y = 0, radius 24.5 -> players fall off past edge!)
    const deckShape = new CANNON.Cylinder(24.5, 23.2, 2.2, 16);
    const deckBody = new CANNON.Body({ mass: 0, material: this.groundPhysMat });
    deckBody.addShape(deckShape);
    deckBody.position.set(0, -1.1, 0);
    this.world.addBody(deckBody);

    // 4 Corner Pillar Colliders
    const cornerAngles = [
      Math.PI * 0.25,
      Math.PI * 0.75,
      Math.PI * 1.25,
      Math.PI * 1.75,
    ];
    for (const ang of cornerAngles) {
      const colBody = new CANNON.Body({ mass: 0, material: this.groundPhysMat });
      colBody.addShape(new CANNON.Box(new CANNON.Vec3(1.15, 2.8, 1.15)));
      colBody.position.set(Math.cos(ang) * 21.2, 2.8, Math.sin(ang) * 21.2);
      this.world.addBody(colBody);
    }

    // Goal Gate Post Colliders (West X = -20.8, East X = +20.8, posts at Z = ±4.4)
    for (const xPos of [-20.8, 20.8]) {
      for (const zSide of [-4.4, 4.4]) {
        const postBody = new CANNON.Body({ mass: 0, material: this.groundPhysMat });
        postBody.addShape(new CANNON.Cylinder(0.6, 0.65, 4.8, 10));
        postBody.position.set(xPos, 2.4, zSide);
        this.world.addBody(postBody);
      }
    }
  }

  private initSolarCore(): void {
    const radius = 1.12;
    this.solarCoreBody = new CANNON.Body({
      mass: 2.1,
      material: this.corePhysMat,
      linearDamping: 0.16,
      angularDamping: 0.2,
    });
    this.solarCoreBody.addShape(new CANNON.Sphere(radius));
    this.solarCoreBody.position.set(0, 2.6, 0);

    this.solarCoreBody.addEventListener(
      'collide',
      (ev: { body: CANNON.Body }) => {
        for (const actor of this.actors.values()) {
          if (actor.body === ev.body) {
            this.solarCoreLastTouchId = actor.state.id;
            break;
          }
        }
      }
    );
    this.world.addBody(this.solarCoreBody);

    this.solarCoreGroup = new THREE.Group();
    const innerSun = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.76, 2),
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: 0xf59e0b,
        emissiveIntensity: 1.9,
        roughness: 0.15,
      })
    );

    const brassCageMat = new THREE.MeshStandardMaterial({
      color: 0xeab308,
      roughness: 0.22,
      metalness: 0.88,
    });

    this.solarCoreRingA = new THREE.Mesh(
      new THREE.TorusGeometry(1.06, 0.085, 12, 28),
      brassCageMat
    );
    this.solarCoreRingA.castShadow = !isSoftwareGl;

    this.solarCoreRingB = new THREE.Mesh(
      new THREE.TorusGeometry(0.96, 0.075, 12, 28),
      brassCageMat
    );
    this.solarCoreRingB.rotation.x = Math.PI * 0.5;
    this.solarCoreRingB.castShadow = !isSoftwareGl;

    this.solarCoreGroup.add(innerSun, this.solarCoreRingA, this.solarCoreRingB);
    this.scene.add(this.solarCoreGroup);

    this.solarCoreShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 2.6),
      new THREE.MeshBasicMaterial({
        map: getRadialShadowTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.75,
      })
    );
    this.solarCoreShadow.rotation.x = -Math.PI * 0.5;
    this.solarCoreShadow.position.y = 0.03;
    this.scene.add(this.solarCoreShadow);
  }

  private initDynamicProps(): void {
    const crateSpots: Vec3Tuple[] = [
      { x: -6.8, y: 1.2, z: -4.2 },
      { x: 6.8, y: 1.2, z: -4.2 },
      { x: -6.8, y: 1.2, z: 4.2 },
      { x: 6.8, y: 1.2, z: 4.2 },
    ];
    const bumperSpots: Vec3Tuple[] = [
      { x: 0, y: 1.2, z: -13.2 },
      { x: 0, y: 1.2, z: 6.5 },
    ];

    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0xe6dccf,
      roughness: 0.65,
      metalness: 0.1,
    });
    const bronzeMat = new THREE.MeshStandardMaterial({
      color: 0xc89646,
      roughness: 0.28,
      metalness: 0.85,
    });
    const bumperCoreMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 1.3,
      roughness: 0.2,
    });

    crateSpots.forEach((spot, idx) => {
      const id = `crate-${idx}`;
      const body = new CANNON.Body({
        mass: 2.8,
        material: this.groundPhysMat,
        linearDamping: 0.25,
        angularDamping: 0.3,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.75, 0.75, 0.75)));
      body.position.set(spot.x, spot.y, spot.z);
      this.world.addBody(body);

      // Composite 3-part Stone & Bronze Relic Crate
      const group = new THREE.Group();
      const coreBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.36, 1.36, 1.36),
        stoneMat
      );
      coreBox.castShadow = !isSoftwareGl;
      coreBox.receiveShadow = !isSoftwareGl;

      const frameA = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.22, 1.5),
        bronzeMat
      );
      frameA.position.y = 0.56;
      const frameB = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.22, 1.5),
        bronzeMat
      );
      frameB.position.y = -0.56;

      group.add(coreBox, frameA, frameB);
      this.scene.add(group);

      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.0, 2.0),
        new THREE.MeshBasicMaterial({
          map: getRadialShadowTexture(),
          transparent: true,
          depthWrite: false,
          opacity: 0.65,
        })
      );
      shadow.rotation.x = -Math.PI * 0.5;
      shadow.position.y = 0.025;
      this.scene.add(shadow);

      this.props.push({ id, kind: 'crate', spawnPos: spot, body, mesh: group, shadow });
    });

    bumperSpots.forEach((spot, idx) => {
      const id = `bumper-${idx}`;
      const body = new CANNON.Body({
        mass: 4.5,
        material: this.corePhysMat,
        linearDamping: 0.35,
        angularDamping: 0.45,
      });
      body.addShape(new CANNON.Cylinder(0.95, 0.95, 1.6, 12));
      body.position.set(spot.x, spot.y, spot.z);
      this.world.addBody(body);

      // Composite 3-part Kinetic Bumper Pylon
      const group = new THREE.Group();
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.9, 1.55, 16),
        bronzeMat
      );
      barrel.castShadow = !isSoftwareGl;
      const energyBand = new THREE.Mesh(
        new THREE.TorusGeometry(0.92, 0.12, 10, 24),
        bumperCoreMat
      );
      energyBand.rotation.x = Math.PI * 0.5;
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.75, 0.25, 16),
        stoneMat
      );
      cap.position.y = 0.85;

      group.add(barrel, energyBand, cap);
      this.scene.add(group);

      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 2.2),
        new THREE.MeshBasicMaterial({
          map: getRadialShadowTexture(),
          transparent: true,
          depthWrite: false,
          opacity: 0.7,
        })
      );
      shadow.rotation.x = -Math.PI * 0.5;
      shadow.position.y = 0.025;
      this.scene.add(shadow);

      this.props.push({ id, kind: 'bumper', spawnPos: spot, body, mesh: group, shadow });
    });
  }

  private initRadiantShards(): void {
    const spots: Vec3Tuple[] = [
      { x: -11.5, y: 1.15, z: -10.5 },
      { x: 11.5, y: 1.15, z: -10.5 },
      { x: -11.5, y: 1.15, z: 10.5 },
      { x: 11.5, y: 1.15, z: 10.5 },
    ];

    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.6,
      roughness: 0.15,
    });
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xd4a359,
      roughness: 0.3,
      metalness: 0.85,
    });

    spots.forEach((pos, idx) => {
      const group = new THREE.Group();
      group.position.set(pos.x, pos.y, pos.z);

      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45, 0),
        crystalMat
      );
      const collar = new THREE.Mesh(
        new THREE.TorusGeometry(0.58, 0.045, 8, 20),
        ringMat
      );
      collar.rotation.x = Math.PI * 0.5;
      group.add(gem, collar);
      this.scene.add(group);

      this.shards.push({
        state: {
          id: `shard-${idx}`,
          position: { ...pos },
          active: true,
          respawnTimer: 0,
        },
        mesh: group,
      });
    });
  }

  private spawnOrUpdateActor(state: PlayerSyncState): InternalActor {
    const existing = this.actors.get(state.id);
    if (existing) {
      existing.state.name = state.name;
      existing.state.colorHex = state.colorHex;
      existing.visual.baseColor.set(state.colorHex);
      existing.visual.hullMaterial.color.copy(existing.visual.baseColor);
      existing.visual.emissiveMaterial.emissive.copy(existing.visual.baseColor);
      return existing;
    }

    const body = new CANNON.Body({
      mass: 5.0,
      material: this.playerPhysMat,
      fixedRotation: true,
      linearDamping: 0.42,
    });
    // Sphere collider radius 0.68 offset so bottom of actor root sits flush at Y = 0
    body.addShape(new CANNON.Sphere(0.68), new CANNON.Vec3(0, 0.68, 0));
    body.position.set(state.position.x, state.position.y, state.position.z);

    body.addEventListener('collide', (ev: { body: CANNON.Body }) => {
      for (const other of this.actors.values()) {
        if (other.body === ev.body && other.state.id !== state.id) {
          const otherSpeed = other.body.velocity.length();
          if (otherSpeed > 8.5) {
            state.lastHitById = other.state.id;
            state.lastHitTimestamp = Date.now();
          }
        }
      }
    });

    this.world.addBody(body);

    const visual = createStrikerVisualRig(state.colorHex, !isSoftwareGl);
    visual.root.position.set(state.position.x, state.position.y, state.position.z);
    this.scene.add(visual.root);

    const actor: InternalActor = {
      state,
      body,
      visual,
      scaleSquashX: 1,
      scaleSquashY: 1,
      coyoteTimer: 0,
      jumpBufferTimer: 0,
      wasGrounded: true,
      travelPhase: 0,
      koRespawnTimer: 0,
    };
    this.actors.set(state.id, actor);
    this.emitNameplates();
    return actor;
  }

  private removeActor(id: string): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    this.world.removeBody(actor.body);
    this.scene.remove(actor.visual.root);
    this.actors.delete(id);
    this.emitNameplates();
  }

  private emitNameplates(): void {
    const list: NameplateDomHandle[] = [];
    for (const actor of this.actors.values()) {
      list.push({
        id: actor.state.id,
        name: actor.state.name,
        colorHex: actor.state.colorHex,
        isBot: actor.state.isBot,
        isLocal: actor.state.id === this.localPlayerId,
      });
    }
    this.callbacks.onNameplatesChanged(list);
  }

  public configureSession(params: {
    role: NetworkRole;
    localPlayerId: string;
    localName: string;
    localColor: string;
    botCount: number;
  }): void {
    this.role = params.role;
    this.localPlayerId = params.localPlayerId;
    this.localName = params.localName;
    this.localColor = params.localColor;
    this.desiredBotCount = params.botCount;

    this.rebuildRoster(
      this.localPlayerId,
      this.localName,
      this.localColor,
      params.role === 'client' ? 0 : params.botCount
    );
    this.resetMatchState(false);
  }

  public setBotCount(count: number): void {
    this.desiredBotCount = Math.max(0, Math.min(3, count));
    if (this.role === 'client') return;

    // Add or remove bots dynamically without resetting human players!
    for (let i = 0; i < BOT_DEFS.length; i++) {
      const def = BOT_DEFS[i];
      if (i < this.desiredBotCount) {
        if (!this.actors.has(def.id)) {
          const spawn = SPAWN_POINTS[(i + 1) % SPAWN_POINTS.length];
          this.spawnOrUpdateActor({
            id: def.id,
            name: def.name,
            colorHex: def.color,
            isHost: false,
            isBot: true,
            archetype: def.archetype,
            position: { ...spawn },
            velocity: { x: 0, y: 0, z: 0 },
            yaw: Math.atan2(-spawn.x, -spawn.z),
            stability: 3,
            maxStability: 3,
            score: 0,
            knockouts: 0,
            coreGoals: 0,
            dashCooldown: 0,
            shockwaveCooldown: 0,
            telegraphProgress: 0,
            lastHitById: null,
            lastHitTimestamp: 0,
          });
        }
      } else {
        this.removeActor(def.id);
      }
    }
  }

  private rebuildRoster(
    localId: string,
    localName: string,
    localColor: string,
    botCount: number
  ): void {
    for (const id of Array.from(this.actors.keys())) {
      this.removeActor(id);
    }

    // Spawn local player at South Vista (0, 1.5, 12.5) facing North (yaw = PI) toward Core & Sun-Spire!
    const localSpawn = this.role === 'client' ? SPAWN_POINTS[1] : SPAWN_POINTS[0];
    this.spawnOrUpdateActor({
      id: localId,
      name: localName,
      colorHex: localColor,
      isHost: this.role !== 'client',
      isBot: false,
      position: { ...localSpawn },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: Math.atan2(-localSpawn.x, -localSpawn.z),
      stability: 3,
      maxStability: 3,
      score: 0,
      knockouts: 0,
      coreGoals: 0,
      dashCooldown: 0,
      shockwaveCooldown: 0,
      telegraphProgress: 0,
      lastHitById: null,
      lastHitTimestamp: 0,
    });

    this.setBotCount(botCount);
  }

  public setShellState(next: GameShellState): void {
    this.shellState = next;
    document.body.dataset.state = next;
    if (next === 'playing') {
      this.clearHeldInputs();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    } else {
      document.exitPointerLock?.();
    }
  }

  public resetMatchState(broadcastIfHost = true): void {
    this.matchTimeRemaining = MATCH_DURATION_SECONDS;
    this.matchElapsed = 0;
    this.matchEnded = false;
    this.hitstopTimer = 0;
    this.cameraTrauma = 0;
    this.solarCoreLastTouchId = null;

    this.solarCoreBody.position.set(0, 3.2, 0);
    this.solarCoreBody.velocity.set(0, 0, 0);
    this.solarCoreBody.angularVelocity.set(0, 0, 0);

    for (const p of this.props) {
      p.body.position.set(p.spawnPos.x, p.spawnPos.y, p.spawnPos.z);
      p.body.velocity.set(0, 0, 0);
      p.body.angularVelocity.set(0, 0, 0);
      p.body.quaternion.set(0, 0, 0, 1);
    }

    for (const s of this.shards) {
      s.state.active = true;
      s.state.respawnTimer = 0;
      s.mesh.visible = true;
    }

    let idx = 0;
    for (const actor of this.actors.values()) {
      const sp = SPAWN_POINTS[idx % SPAWN_POINTS.length];
      idx += 1;
      actor.body.position.set(sp.x, sp.y, sp.z);
      actor.body.velocity.set(0, 0, 0);
      actor.state.position = { ...sp };
      actor.state.velocity = { x: 0, y: 0, z: 0 };
      actor.state.yaw = Math.atan2(-sp.x, -sp.z);
      actor.state.stability = 3;
      actor.state.score = 0;
      actor.state.knockouts = 0;
      actor.state.coreGoals = 0;
      actor.state.dashCooldown = 0;
      actor.state.shockwaveCooldown = 0;
      actor.state.telegraphProgress = 0;
      actor.state.lastHitById = null;
    }

    if (broadcastIfHost && this.role === 'host') {
      this.callbacks.sendReliablePacket({
        type: 'arena-event',
        eventKind: 'match-reset',
        actorId: this.localPlayerId,
        actorName: this.localName,
        position: { x: 0, y: 1, z: 0 },
      });
    }
    this.pushHudSnapshot();
  }

  public handlePeerConnected(
    peerId: string,
    name: string,
    colorHex: string
  ): void {
    if (this.role === 'host') {
      const idx = this.actors.size % SPAWN_POINTS.length;
      const sp = SPAWN_POINTS[idx];
      this.spawnOrUpdateActor({
        id: peerId,
        name,
        colorHex,
        isHost: false,
        isBot: false,
        position: { ...sp },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: Math.atan2(-sp.x, -sp.z),
        stability: 3,
        maxStability: 3,
        score: 0,
        knockouts: 0,
        coreGoals: 0,
        dashCooldown: 0,
        shockwaveCooldown: 0,
        telegraphProgress: 0,
        lastHitById: null,
        lastHitTimestamp: 0,
      });
    }
  }

  public handlePeerDisconnected(peerId: string): void {
    this.removeActor(peerId);
  }

  public handleIncomingFastPacket(
    fromPeerId: string,
    packet: FastDataPacket
  ): void {
    if (this.role === 'host' && packet.type === 'client-state') {
      this.applyClientInputOnHost(fromPeerId, packet);
    } else if (this.role === 'client' && packet.type === 'world-snapshot') {
      this.applyHostWorldSnapshotOnClient(packet);
    }
  }

  public handleIncomingReliablePacket(
    _fromPeerId: string,
    packet: ReliableDataPacket
  ): void {
    if (packet.type === 'arena-event') {
      this.handleRemoteArenaEvent(packet);
    }
  }

  private applyClientInputOnHost(
    peerId: string,
    pkt: ClientInputPacket
  ): void {
    let actor = this.actors.get(peerId);
    if (!actor) {
      actor = this.spawnOrUpdateActor({
        id: peerId,
        name: pkt.name,
        colorHex: pkt.colorHex,
        isHost: false,
        isBot: false,
        position: { ...pkt.position },
        velocity: { ...pkt.velocity },
        yaw: pkt.yaw,
        stability: 3,
        maxStability: 3,
        score: 0,
        knockouts: 0,
        coreGoals: 0,
        dashCooldown: 0,
        shockwaveCooldown: 0,
        telegraphProgress: 0,
        lastHitById: null,
        lastHitTimestamp: 0,
      });
    }

    actor.state.name = pkt.name;
    actor.state.yaw = pkt.yaw;
    // Blend client's reported position with host physics body so collisions with core/shockwaves feel authoritative
    actor.body.position.set(
      actor.body.position.x * 0.25 + pkt.position.x * 0.75,
      actor.body.position.y * 0.25 + pkt.position.y * 0.75,
      actor.body.position.z * 0.25 + pkt.position.z * 0.75
    );
    actor.body.velocity.set(pkt.velocity.x, pkt.velocity.y, pkt.velocity.z);

    if (pkt.dashJustTriggered) {
      this.triggerDash(actor, false);
    }
    if (pkt.shockwaveJustTriggered) {
      this.triggerShockwave(actor, true);
    }
  }

  private applyHostWorldSnapshotOnClient(snap: WorldSnapshotPacket): void {
    this.matchTimeRemaining = snap.matchTimeRemaining;

    const incomingIds = new Set<string>();
    for (const pState of snap.players) {
      incomingIds.add(pState.id);
      const actor = this.spawnOrUpdateActor({ ...pState });

      if (pState.id === this.localPlayerId) {
        // Reconcile authoritative score/stability; only snap position if knocked strongly or respawned
        actor.state.score = pState.score;
        actor.state.knockouts = pState.knockouts;
        actor.state.coreGoals = pState.coreGoals;
        actor.state.stability = pState.stability;

        const driftSq =
          (actor.body.position.x - pState.position.x) ** 2 +
          (actor.body.position.y - pState.position.y) ** 2 +
          (actor.body.position.z - pState.position.z) ** 2;
        if (driftSq > 28) {
          actor.body.position.set(
            pState.position.x,
            pState.position.y,
            pState.position.z
          );
          actor.body.velocity.set(
            pState.velocity.x,
            pState.velocity.y,
            pState.velocity.z
          );
        }
      } else {
        // Store target network state on remote actor for 60Hz exponential damping in tick()
        actor.state.position = { ...pState.position };
        actor.state.velocity = { ...pState.velocity };
        actor.state.yaw = pState.yaw;
        actor.state.score = pState.score;
        actor.state.knockouts = pState.knockouts;
        actor.state.coreGoals = pState.coreGoals;
        actor.state.stability = pState.stability;
        actor.state.telegraphProgress = pState.telegraphProgress;
      }
    }

    for (const existingId of Array.from(this.actors.keys())) {
      if (existingId !== this.localPlayerId && !incomingIds.has(existingId)) {
        this.removeActor(existingId);
      }
    }

    // Sync Solar Core
    this.solarCoreBody.position.set(
      this.solarCoreBody.position.x * 0.35 + snap.solarCore.position.x * 0.65,
      this.solarCoreBody.position.y * 0.35 + snap.solarCore.position.y * 0.65,
      this.solarCoreBody.position.z * 0.35 + snap.solarCore.position.z * 0.65
    );
    this.solarCoreBody.velocity.set(
      snap.solarCore.velocity.x,
      snap.solarCore.velocity.y,
      snap.solarCore.velocity.z
    );
    this.solarCoreBody.quaternion.set(
      snap.solarCore.quaternion.x,
      snap.solarCore.quaternion.y,
      snap.solarCore.quaternion.z,
      snap.solarCore.quaternion.w
    );

    // Sync Cannon.js Dynamic Props
    for (const pSync of snap.props) {
      const localProp = this.props.find((pr) => pr.id === pSync.id);
      if (localProp) {
        localProp.body.position.set(
          localProp.body.position.x * 0.35 + pSync.position.x * 0.65,
          localProp.body.position.y * 0.35 + pSync.position.y * 0.65,
          localProp.body.position.z * 0.35 + pSync.position.z * 0.65
        );
        localProp.body.quaternion.set(
          pSync.quaternion.x,
          pSync.quaternion.y,
          pSync.quaternion.z,
          pSync.quaternion.w
        );
        localProp.body.velocity.set(
          pSync.velocity.x,
          pSync.velocity.y,
          pSync.velocity.z
        );
      }
    }

    // Sync Shards
    for (const sSync of snap.shards) {
      const localShard = this.shards.find((sh) => sh.state.id === sSync.id);
      if (localShard) {
        localShard.state.active = sSync.active;
        localShard.mesh.visible = sSync.active;
      }
    }
  }

  private handleRemoteArenaEvent(ev: ArenaEventPacket): void {
    switch (ev.eventKind) {
      case 'shockwave': {
        const actor = this.actors.get(ev.actorId);
        if (actor) {
          actor.visual.shockwaveAnim = 1.0;
        }
        this.particles.burst(
          ev.position.x,
          ev.position.y + 0.5,
          ev.position.z,
          20,
          0xfef08a,
          9.5
        );
        arenaAudio.playShockwave();
        // Apply impulse locally on client if within blast radius so knockback feels instant!
        const localActor = this.actors.get(this.localPlayerId);
        if (localActor && ev.actorId !== this.localPlayerId) {
          const hit = calculateShockwaveImpulse(
            ev.position,
            {
              x: localActor.body.position.x,
              y: localActor.body.position.y,
              z: localActor.body.position.z,
            },
            localActor.state.stability
          );
          if (hit.hit) {
            _cannonImpulse.set(hit.impulse.x, hit.impulse.y, hit.impulse.z);
            localActor.body.velocity.vadd(_cannonImpulse, localActor.body.velocity);
            localActor.visual.flashTimer = 0.08;
            this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.55);
            this.hitstopTimer = 0.045;
          }
        }
        break;
      }
      case 'knockout': {
        arenaAudio.playKnockout();
        this.particles.burst(
          ev.position.x,
          Math.max(-2, ev.position.y),
          ev.position.z,
          26,
          0xf97316,
          12
        );
        const msg = ev.pointsAwarded
          ? `${ev.actorName} Ring-Out KO'd ${ev.targetName}! +${ev.pointsAwarded}`
          : `${ev.actorName} fell into the cloud sea!`;
        this.callbacks.onFeedEvent(msg, '#f59e0b');
        break;
      }
      case 'core-goal': {
        arenaAudio.playGoalFanfare();
        this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.65);
        this.hitstopTimer = 0.06;
        this.particles.burst(
          ev.position.x,
          ev.position.y + 1.5,
          ev.position.z,
          36,
          0xfacc15,
          14
        );
        this.callbacks.onFeedEvent(
          `${ev.actorName} blasted the Solar Core Goal! +3`,
          '#eab308'
        );
        break;
      }
      case 'shard-pickup': {
        arenaAudio.playShardPickup();
        this.particles.burst(
          ev.position.x,
          ev.position.y,
          ev.position.z,
          12,
          0xfef08a,
          5.5
        );
        break;
      }
      case 'match-reset': {
        this.resetMatchState(false);
        this.setShellState('playing');
        break;
      }
      case 'match-end': {
        if (ev.summary) {
          this.matchEnded = true;
          const isLocalWin = ev.summary.winnerId === this.localPlayerId;
          arenaAudio.playMatchEnd(isLocalWin);
          this.setShellState('gameover');
          this.callbacks.onMatchFinished({
            ...ev.summary,
            isLocalVictory: isLocalWin,
          });
        }
        break;
      }
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const code = e.code;
    if (!this.keysHeld.has(code)) {
      this.keysJustPressed.add(code);
    }
    this.keysHeld.add(code);

    if (
      this.shellState === 'playing' &&
      (code === 'Space' ||
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight')
    ) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keysHeld.delete(e.code);
    if (e.code === 'Space' && this.shellState === 'playing') {
      // Variable jump cut on early Space release while ascending!
      const local = this.actors.get(this.localPlayerId);
      if (local && local.body.velocity.y > 2.5) {
        local.body.velocity.y *= 0.48;
      }
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.shellState !== 'playing') return;
    if (e.button === 0) {
      arenaAudio.unlock();
      this.pointerShockwaveQueued = true;
    }
  };

  private clearHeldInputs = (): void => {
    this.keysHeld.clear();
    this.keysJustPressed.clear();
    this.pointerShockwaveQueued = false;
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.clearHeldInputs();
    }
  };

  private isActorGrounded(actor: InternalActor): boolean {
    const px = actor.body.position.x;
    const pz = actor.body.position.z;
    const py = actor.body.position.y;
    const radial = Math.hypot(px, pz);
    return radial <= ARENA_RADIUS + 0.4 && py <= 0.14 && py >= -0.5 && actor.body.velocity.y <= 2.0;
  }

  private triggerDash(actor: InternalActor, emitForClient = true): void {
    if (actor.state.dashCooldown > 0) return;
    actor.state.dashCooldown = 1.65;

    const dirX = Math.sin(actor.state.yaw);
    const dirZ = Math.cos(actor.state.yaw);
    actor.body.velocity.x = dirX * 19.5;
    actor.body.velocity.z = dirZ * 19.5;
    actor.body.velocity.y = Math.max(actor.body.velocity.y, 2.2);

    actor.scaleSquashX = 0.8;
    actor.scaleSquashY = 1.22;

    this.particles.burst(
      actor.body.position.x,
      actor.body.position.y + 0.6,
      actor.body.position.z,
      9,
      actor.state.colorHex,
      6.5
    );
    arenaAudio.playDash();

    if (emitForClient && this.role === 'client' && actor.state.id === this.localPlayerId) {
      this.pendingNetDash = true;
    }
  }

  private triggerShockwave(actor: InternalActor, broadcastEvent: boolean): void {
    if (actor.state.shockwaveCooldown > 0) return;
    actor.state.shockwaveCooldown = 2.6;
    actor.visual.shockwaveAnim = 1.0;

    const origin: Vec3Tuple = {
      x: actor.body.position.x,
      y: actor.body.position.y,
      z: actor.body.position.z,
    };

    this.particles.burst(origin.x, origin.y + 0.45, origin.z, 22, 0xfef08a, 10.5);
    arenaAudio.playShockwave();
    if (actor.state.id === this.localPlayerId) {
      this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.38);
    }

    if (this.role !== 'client') {
      let hitSomeone = false;
      for (const target of this.actors.values()) {
        if (target.state.id === actor.state.id) continue;
        const res = calculateShockwaveImpulse(
          origin,
          {
            x: target.body.position.x,
            y: target.body.position.y,
            z: target.body.position.z,
          },
          target.state.stability
        );
        if (res.hit) {
          hitSomeone = true;
          target.body.velocity.x += res.impulse.x;
          target.body.velocity.y += res.impulse.y;
          target.body.velocity.z += res.impulse.z;
          target.state.stability = Math.max(0, target.state.stability - res.stabilityDamage);
          target.state.lastHitById = actor.state.id;
          target.state.lastHitTimestamp = Date.now();
          target.visual.flashTimer = 0.07;
        }
      }

      // Blast the Solar Core & Cannon.js Dynamic Props too!
      const coreHit = calculateShockwaveImpulse(
        origin,
        {
          x: this.solarCoreBody.position.x,
          y: this.solarCoreBody.position.y,
          z: this.solarCoreBody.position.z,
        },
        1,
        7.8,
        22.5
      );
      if (coreHit.hit) {
        hitSomeone = true;
        this.solarCoreLastTouchId = actor.state.id;
        this.solarCoreBody.velocity.x += coreHit.impulse.x;
        this.solarCoreBody.velocity.y += coreHit.impulse.y * 0.65;
        this.solarCoreBody.velocity.z += coreHit.impulse.z;
      }

      for (const prop of this.props) {
        const pHit = calculateShockwaveImpulse(
          origin,
          {
            x: prop.body.position.x,
            y: prop.body.position.y,
            z: prop.body.position.z,
          },
          2,
          7.2,
          15
        );
        if (pHit.hit) {
          prop.body.velocity.x += pHit.impulse.x;
          prop.body.velocity.y += pHit.impulse.y * 0.55;
          prop.body.velocity.z += pHit.impulse.z;
        }
      }

      if (hitSomeone) {
        this.hitstopTimer = 0.045;
        this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.45);
      }

      if (broadcastEvent && this.role === 'host') {
        this.callbacks.sendReliablePacket({
          type: 'arena-event',
          eventKind: 'shockwave',
          actorId: actor.state.id,
          actorName: actor.state.name,
          position: origin,
        });
      }
    } else if (actor.state.id === this.localPlayerId) {
      this.pendingNetShockwave = true;
    }
  }

  private stepLocalPlayerControls(local: InternalActor, dt: number): void {
    // Camera-relative movement on XZ plane
    let rawX = 0;
    let rawZ = 0;
    if (this.keysHeld.has('KeyW') || this.keysHeld.has('ArrowUp')) rawZ -= 1;
    if (this.keysHeld.has('KeyS') || this.keysHeld.has('ArrowDown')) rawZ += 1;
    if (this.keysHeld.has('KeyA') || this.keysHeld.has('ArrowLeft')) rawX -= 1;
    if (this.keysHeld.has('KeyD') || this.keysHeld.has('ArrowRight')) rawX += 1;

    const grounded = this.isActorGrounded(local);
    if (grounded && !local.wasGrounded && local.body.velocity.y < -2) {
      local.scaleSquashX = 1.2;
      local.scaleSquashY = 0.8;
      arenaAudio.playLand();
    }
    local.wasGrounded = grounded;

    if (grounded) {
      local.coyoteTimer = 0.11;
    } else {
      local.coyoteTimer = Math.max(0, local.coyoteTimer - dt);
    }

    if (this.keysJustPressed.has('Space')) {
      arenaAudio.unlock();
      local.jumpBufferTimer = 0.13;
    } else {
      local.jumpBufferTimer = Math.max(0, local.jumpBufferTimer - dt);
    }

    if (local.jumpBufferTimer > 0 && local.coyoteTimer > 0) {
      local.body.velocity.y = 11.4;
      local.jumpBufferTimer = 0;
      local.coyoteTimer = 0;
      local.scaleSquashX = 0.85;
      local.scaleSquashY = 1.18;
      arenaAudio.playJump();
      this.particles.burst(
        local.body.position.x,
        local.body.position.y + 0.1,
        local.body.position.z,
        5,
        0xfef3c7,
        4.0
      );
    }

    if (rawX !== 0 || rawZ !== 0) {
      _moveDir.set(rawX, 0, rawZ).normalize();
      const targetSpeed = 11.2;
      const accel = grounded ? 14.0 : 7.5;
      const blend = 1 - Math.exp(-accel * dt);
      local.body.velocity.x += (_moveDir.x * targetSpeed - local.body.velocity.x) * blend;
      local.body.velocity.z += (_moveDir.z * targetSpeed - local.body.velocity.z) * blend;

      const desiredYaw = Math.atan2(_moveDir.x, _moveDir.z);
      local.state.yaw += shortestAngleDelta(local.state.yaw, desiredYaw) * (1 - Math.exp(-15 * dt));
    } else if (grounded) {
      const decel = 1 - Math.exp(-10 * dt);
      local.body.velocity.x *= 1 - decel * 0.7;
      local.body.velocity.z *= 1 - decel * 0.7;
    }

    if (
      this.keysJustPressed.has('ShiftLeft') ||
      this.keysJustPressed.has('ShiftRight')
    ) {
      arenaAudio.unlock();
      this.triggerDash(local, true);
    }

    if (this.keysJustPressed.has('KeyE') || this.pointerShockwaveQueued) {
      this.triggerShockwave(local, true);
    }
  }

  private stepHostSimulation(simDt: number): void {
    const allStates = Array.from(this.actors.values()).map((a) => a.state);
    const activeShard =
      this.shards.find((s) => s.state.active)?.state.position ?? null;

    // 1. Update AI Bot Decisions (3 distinct archetypes)
    for (const actor of this.actors.values()) {
      actor.state.dashCooldown = Math.max(0, actor.state.dashCooldown - simDt);
      actor.state.shockwaveCooldown = Math.max(
        0,
        actor.state.shockwaveCooldown - simDt
      );

      if (!actor.state.isBot) continue;

      const intent = computeBotIntent({
        bot: actor.state,
        rivals: allStates,
        solarCorePos: {
          x: this.solarCoreBody.position.x,
          y: this.solarCoreBody.position.y,
          z: this.solarCoreBody.position.z,
        },
        activeShardPos: activeShard,
        dt: simDt,
        elapsedTime: this.matchElapsed,
      });

      actor.state.telegraphProgress = intent.nextTelegraph;
      const botSpeed = 9.2;
      const blend = 1 - Math.exp(-10 * simDt);
      actor.body.velocity.x += (intent.moveX * botSpeed - actor.body.velocity.x) * blend;
      actor.body.velocity.z += (intent.moveZ * botSpeed - actor.body.velocity.z) * blend;
      actor.state.yaw +=
        shortestAngleDelta(actor.state.yaw, intent.desiredYaw) *
        (1 - Math.exp(-12 * simDt));

      if (intent.jump && this.isActorGrounded(actor)) {
        actor.body.velocity.y = 10.5;
      }
      if (intent.dash) {
        this.triggerDash(actor, false);
      }
      if (intent.shockwave) {
        this.triggerShockwave(actor, true);
      }
    }

    // 2. Step Cannon.js Physics World
    this.world.step(1 / 60, simDt, 3);

    // 3. Evaluate Ring-Out KOs, Prop Respawns, Shard Pickups & Solar Core Goals
    const nowMs = Date.now();
    let idx = 0;
    for (const actor of this.actors.values()) {
      actor.state.position = {
        x: actor.body.position.x,
        y: actor.body.position.y,
        z: actor.body.position.z,
      };
      actor.state.velocity = {
        x: actor.body.velocity.x,
        y: actor.body.velocity.y,
        z: actor.body.velocity.z,
      };

      const ko = evaluateRingOut(actor.state, nowMs);
      if (ko.isRingOut) {
        let attackerName = actor.state.name;
        if (ko.creditedAttackerId) {
          const attacker = this.actors.get(ko.creditedAttackerId);
          if (attacker) {
            attacker.state.score += ko.pointsAwarded;
            attacker.state.knockouts += 1;
            attackerName = attacker.state.name;
          }
        }

        const fallPos = { ...actor.state.position };
        this.particles.burst(fallPos.x, -3.5, fallPos.z, 26, 0xf97316, 12);
        arenaAudio.playKnockout();

        const feedMsg = ko.creditedAttackerId
          ? `${attackerName} Ring-Out KO'd ${actor.state.name}! +2`
          : `${actor.state.name} fell into the cloud sea!`;
        this.callbacks.onFeedEvent(feedMsg, '#f59e0b');

        if (this.role === 'host') {
          this.callbacks.sendReliablePacket({
            type: 'arena-event',
            eventKind: 'knockout',
            actorId: ko.creditedAttackerId ?? actor.state.id,
            actorName: attackerName,
            targetName: actor.state.name,
            position: fallPos,
            pointsAwarded: ko.pointsAwarded,
          });
        }

        // Respawn striker cleanly above plaza
        const sp = SPAWN_POINTS[idx % SPAWN_POINTS.length];
        actor.body.position.set(sp.x, 3.4, sp.z);
        actor.body.velocity.set(0, 0, 0);
        actor.state.stability = 3;
        actor.state.lastHitById = null;
        actor.state.telegraphProgress = 0;
      }
      idx += 1;
    }

    // Check Radiant Shards
    for (const shard of this.shards) {
      if (!shard.state.active) {
        shard.state.respawnTimer -= simDt;
        if (shard.state.respawnTimer <= 0) {
          shard.state.active = true;
          shard.mesh.visible = true;
        }
        continue;
      }

      for (const actor of this.actors.values()) {
        const dx = actor.body.position.x - shard.state.position.x;
        const dz = actor.body.position.z - shard.state.position.z;
        const dy = actor.body.position.y - shard.state.position.y;
        if (dx * dx + dz * dz < 2.25 && Math.abs(dy) < 2.0) {
          shard.state.active = false;
          shard.state.respawnTimer = 9.0;
          shard.mesh.visible = false;
          actor.state.score += 1;
          actor.state.stability = Math.min(
            actor.state.maxStability,
            actor.state.stability + 1
          );
          arenaAudio.playShardPickup();
          this.particles.burst(
            shard.state.position.x,
            shard.state.position.y,
            shard.state.position.z,
            14,
            0xfef08a,
            6
          );
          if (this.role === 'host') {
            this.callbacks.sendReliablePacket({
              type: 'arena-event',
              eventKind: 'shard-pickup',
              actorId: actor.state.id,
              actorName: actor.state.name,
              position: { ...shard.state.position },
              pointsAwarded: 1,
            });
          }
          break;
        }
      }
    }

    // Check Solar Core Goal Gates or Out-of-Bounds
    const corePos: Vec3Tuple = {
      x: this.solarCoreBody.position.x,
      y: this.solarCoreBody.position.y,
      z: this.solarCoreBody.position.z,
    };
    const goalSide = evaluateGoalZone(corePos);
    if (goalSide !== null) {
      const scorer =
        (this.solarCoreLastTouchId && this.actors.get(this.solarCoreLastTouchId)) ||
        this.actors.get(this.localPlayerId);
      if (scorer) {
        scorer.state.score += 3;
        scorer.state.coreGoals += 1;
      }
      const scorerName = scorer?.state.name ?? 'Sunforge';
      arenaAudio.playGoalFanfare();
      this.hitstopTimer = 0.06;
      this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.65);
      this.particles.burst(corePos.x, corePos.y + 1.2, corePos.z, 36, 0xfacc15, 14);
      this.callbacks.onFeedEvent(
        `${scorerName} blasted a Solar Core Goal! +3`,
        '#eab308'
      );

      if (this.role === 'host') {
        this.callbacks.sendReliablePacket({
          type: 'arena-event',
          eventKind: 'core-goal',
          actorId: scorer?.state.id ?? this.localPlayerId,
          actorName: scorerName,
          position: corePos,
          pointsAwarded: 3,
        });
      }

      this.solarCoreBody.position.set(0, 4.2, 0);
      this.solarCoreBody.velocity.set(0, 0, 0);
      this.solarCoreBody.angularVelocity.set(0, 0, 0);
      this.solarCoreLastTouchId = null;
    } else if (corePos.y < -8) {
      this.solarCoreBody.position.set(0, 4.2, 0);
      this.solarCoreBody.velocity.set(0, 0, 0);
      this.solarCoreBody.angularVelocity.set(0, 0, 0);
    }

    // Respawn fallen physics crates back onto plaza
    for (const prop of this.props) {
      if (prop.body.position.y < -9) {
        prop.body.position.set(prop.spawnPos.x, 4.0, prop.spawnPos.z);
        prop.body.velocity.set(0, 0, 0);
        prop.body.angularVelocity.set(0, 0, 0);
        prop.body.quaternion.set(0, 0, 0, 1);
      }
    }

    // Match Clock & Victory Check (only during active 'playing' state)
    if (this.shellState === 'playing' && !this.matchEnded) {
      this.matchTimeRemaining = Math.max(0, this.matchTimeRemaining - simDt);
      this.matchElapsed += simDt;
      const latestPlayers = Array.from(this.actors.values()).map((a) => a.state);
      if (checkMatchEnd(latestPlayers, this.matchTimeRemaining)) {
        this.matchEnded = true;
        const summary = createFrozenMatchSummary(
          latestPlayers,
          this.localPlayerId,
          this.matchElapsed
        );
        arenaAudio.playMatchEnd(summary.isLocalVictory);
        if (this.role === 'host') {
          this.callbacks.sendReliablePacket({
            type: 'arena-event',
            eventKind: 'match-end',
            actorId: summary.winnerId,
            actorName: summary.winnerName,
            position: { x: 0, y: 1, z: 0 },
            summary,
          });
        }
        this.setShellState('gameover');
        this.callbacks.onMatchFinished(summary);
      }
    }
  }

  private stepClientSimulation(simDt: number): void {
    const local = this.actors.get(this.localPlayerId);
    if (local) {
      local.state.dashCooldown = Math.max(0, local.state.dashCooldown - simDt);
      local.state.shockwaveCooldown = Math.max(
        0,
        local.state.shockwaveCooldown - simDt
      );
    }

    // Step local Cannon.js physics for responsive zero-lag movement & collisions
    this.world.step(1 / 60, simDt, 2);

    if (local) {
      local.state.position = {
        x: local.body.position.x,
        y: local.body.position.y,
        z: local.body.position.z,
      };
      local.state.velocity = {
        x: local.body.velocity.x,
        y: local.body.velocity.y,
        z: local.body.velocity.z,
      };
      if (local.body.position.y < -8) {
        const sp = SPAWN_POINTS[1];
        local.body.position.set(sp.x, 3.4, sp.z);
        local.body.velocity.set(0, 0, 0);
      }
    }

    // Smoothly interpolate all remote WebRTC peers & bots using frame-rate-independent damping
    for (const actor of this.actors.values()) {
      if (actor.state.id === this.localPlayerId) continue;
      const curPos = {
        x: actor.body.position.x,
        y: actor.body.position.y,
        z: actor.body.position.z,
      };
      const damped = interpolatePeerTransform(
        curPos,
        actor.visual.bodyGroup.rotation.y,
        actor.state.position,
        actor.state.velocity,
        actor.state.yaw,
        simDt,
        18
      );
      actor.body.position.set(
        damped.position.x,
        damped.position.y,
        damped.position.z
      );
      actor.visual.bodyGroup.rotation.y = damped.yaw;
    }
  }

  private broadcastNetworkTick(dt: number): void {
    this.netSyncAccum += dt;
    if (this.netSyncAccum < 1 / 30) return; // 30Hz P2P sync rate
    this.netSyncAccum = 0;
    this.seqCounter += 1;

    if (this.role === 'host') {
      const players: PlayerSyncState[] = Array.from(this.actors.values()).map(
        (a) => ({ ...a.state })
      );
      const solarCore: SolarCoreSyncState = {
        position: {
          x: this.solarCoreBody.position.x,
          y: this.solarCoreBody.position.y,
          z: this.solarCoreBody.position.z,
        },
        quaternion: {
          x: this.solarCoreBody.quaternion.x,
          y: this.solarCoreBody.quaternion.y,
          z: this.solarCoreBody.quaternion.z,
          w: this.solarCoreBody.quaternion.w,
        },
        velocity: {
          x: this.solarCoreBody.velocity.x,
          y: this.solarCoreBody.velocity.y,
          z: this.solarCoreBody.velocity.z,
        },
        lastTouchPlayerId: this.solarCoreLastTouchId,
      };
      const props: PropSyncState[] = this.props.map((p) => ({
        id: p.id,
        kind: p.kind,
        position: {
          x: p.body.position.x,
          y: p.body.position.y,
          z: p.body.position.z,
        },
        quaternion: {
          x: p.body.quaternion.x,
          y: p.body.quaternion.y,
          z: p.body.quaternion.z,
          w: p.body.quaternion.w,
        },
        velocity: {
          x: p.body.velocity.x,
          y: p.body.velocity.y,
          z: p.body.velocity.z,
        },
      }));
      const shards: ShardSyncState[] = this.shards.map((s) => ({ ...s.state }));

      this.callbacks.sendFastPacket({
        type: 'world-snapshot',
        seq: this.seqCounter,
        timestamp: Date.now(),
        matchTimeRemaining: this.matchTimeRemaining,
        players,
        solarCore,
        props,
        shards,
      });
    } else if (this.role === 'client') {
      const local = this.actors.get(this.localPlayerId);
      if (!local) return;
      this.callbacks.sendFastPacket({
        type: 'client-state',
        seq: this.seqCounter,
        timestamp: Date.now(),
        playerId: this.localPlayerId,
        name: this.localName,
        colorHex: this.localColor,
        position: {
          x: local.body.position.x,
          y: local.body.position.y,
          z: local.body.position.z,
        },
        velocity: {
          x: local.body.velocity.x,
          y: local.body.velocity.y,
          z: local.body.velocity.z,
        },
        yaw: local.state.yaw,
        dashJustTriggered: this.pendingNetDash,
        shockwaveJustTriggered: this.pendingNetShockwave,
      });
      this.pendingNetDash = false;
      this.pendingNetShockwave = false;
    }
  }

  private syncVisualMeshesAndCamera(dt: number, elapsedSec: number): void {
    // Animate Sun-Spire Astrolabe rings & Goal energy fields
    this.envHandles.astrolabeRings.forEach((ring, idx) => {
      ring.rotation.x += dt * (0.28 + idx * 0.14);
      ring.rotation.y += dt * (0.22 - idx * 0.09);
    });
    this.envHandles.spireCrystal.rotation.y += dt * 0.9;
    this.envHandles.spireCrystal.position.y =
      12.2 + Math.sin(elapsedSec * 2.2) * 0.35;

    this.envHandles.goalFields.forEach((field, idx) => {
      const mat = field.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.18 + Math.sin(elapsedSec * 3.2 + idx) * 0.06;
    });

    // Update Solar Core visual mesh & contact shadow
    this.solarCoreGroup.position.set(
      this.solarCoreBody.position.x,
      this.solarCoreBody.position.y,
      this.solarCoreBody.position.z
    );
    _tmpQuat.set(
      this.solarCoreBody.quaternion.x,
      this.solarCoreBody.quaternion.y,
      this.solarCoreBody.quaternion.z,
      this.solarCoreBody.quaternion.w
    );
    this.solarCoreGroup.quaternion.copy(_tmpQuat);
    this.solarCoreRingA.rotation.z += dt * 1.8;
    this.solarCoreRingB.rotation.y -= dt * 1.4;

    const coreOnDeck =
      Math.hypot(this.solarCoreBody.position.x, this.solarCoreBody.position.z) <=
        ARENA_RADIUS && this.solarCoreBody.position.y >= -0.5;
    this.solarCoreShadow.visible = coreOnDeck;
    if (coreOnDeck) {
      this.solarCoreShadow.position.set(
        this.solarCoreBody.position.x,
        0.03,
        this.solarCoreBody.position.z
      );
      const heightFade = Math.max(
        0.2,
        1 - Math.max(0, this.solarCoreBody.position.y - 1.1) * 0.12
      );
      this.solarCoreShadow.scale.setScalar(heightFade);
    }

    // Update Dynamic Props
    for (const prop of this.props) {
      prop.mesh.position.set(
        prop.body.position.x,
        prop.body.position.y,
        prop.body.position.z
      );
      prop.mesh.quaternion.set(
        prop.body.quaternion.x,
        prop.body.quaternion.y,
        prop.body.quaternion.z,
        prop.body.quaternion.w
      );
      const onDeck =
        Math.hypot(prop.body.position.x, prop.body.position.z) <= ARENA_RADIUS &&
        prop.body.position.y >= -0.5;
      prop.shadow.visible = onDeck;
      if (onDeck) {
        prop.shadow.position.set(prop.body.position.x, 0.025, prop.body.position.z);
      }
    }

    // Update Radiant Shards bob & spin
    for (const shard of this.shards) {
      if (!shard.state.active) continue;
      shard.mesh.rotation.y += dt * 1.6;
      shard.mesh.position.y =
        shard.state.position.y + Math.sin(elapsedSec * 3.0 + shard.state.position.x) * 0.16;
    }

    // Update Striker Rigs (gait roll synced to travel distance, squash & stretch, hit flash, shockwave ring)
    for (const actor of this.actors.values()) {
      const bx = actor.body.position.x;
      const by = actor.body.position.y;
      const bz = actor.body.position.z;

      actor.visual.root.position.set(bx, by, bz);
      if (this.role !== 'client' || actor.state.id === this.localPlayerId) {
        actor.visual.bodyGroup.rotation.y = actor.state.yaw;
      }

      const horizSpeed = Math.hypot(actor.body.velocity.x, actor.body.velocity.z);
      actor.travelPhase += horizSpeed * dt * 2.4;
      actor.visual.driveSphere.rotation.x = actor.travelPhase;

      // Subtle forward lean proportional to velocity + crouch during bot telegraph
      const crouchOffset = actor.state.telegraphProgress > 0 ? -0.18 * actor.state.telegraphProgress : 0;
      actor.visual.bodyGroup.position.y =
        crouchOffset + Math.abs(Math.sin(actor.travelPhase * 0.5)) * Math.min(0.06, horizSpeed * 0.006);

      // Exponentially damp squash-and-stretch back to (1, 1, 1)
      const squashDamp = 1 - Math.exp(-14 * dt);
      actor.scaleSquashX += (1 - actor.scaleSquashX) * squashDamp;
      actor.scaleSquashY += (1 - actor.scaleSquashY) * squashDamp;
      actor.visual.bodyGroup.scale.set(
        actor.scaleSquashX,
        actor.scaleSquashY,
        actor.scaleSquashX
      );

      // Hit flash white emissive
      if (actor.visual.flashTimer > 0) {
        actor.visual.flashTimer -= dt;
        actor.visual.hullMaterial.emissive.setHex(0xffffff);
        actor.visual.hullMaterial.emissiveIntensity = 0.85;
      } else {
        actor.visual.hullMaterial.emissive.setHex(0x000000);
        actor.visual.hullMaterial.emissiveIntensity = 0;
      }

      // Telegraph ground ring
      const telMat = actor.visual.telegraphRing.material as THREE.MeshBasicMaterial;
      if (actor.state.telegraphProgress > 0.02) {
        telMat.opacity = 0.35 + actor.state.telegraphProgress * 0.55;
        const s = 1 + actor.state.telegraphProgress * 1.4;
        actor.visual.telegraphRing.scale.setScalar(s);
      } else {
        telMat.opacity = 0;
      }

      // Expanding Shockwave ring
      const waveMat = actor.visual.shockwaveWave.material as THREE.MeshBasicMaterial;
      if (actor.visual.shockwaveAnim > 0) {
        actor.visual.shockwaveAnim = Math.max(0, actor.visual.shockwaveAnim - dt * 2.8);
        const progress = 1 - actor.visual.shockwaveAnim;
        actor.visual.shockwaveWave.scale.setScalar(1 + progress * 5.6);
        waveMat.opacity = actor.visual.shockwaveAnim * 0.85;
      } else {
        waveMat.opacity = 0;
      }

      // Contact shadow only when over deck
      const onDeck = Math.hypot(bx, bz) <= ARENA_RADIUS && by >= -0.4;
      actor.visual.shadowDisc.visible = onDeck;
      if (onDeck) {
        actor.visual.shadowDisc.position.y = Math.max(0.02 - by, -by + 0.02);
      }
    }

    // Camera Choreography:
    // - On 'title': Live World Camera Tour orbiting smoothly around the Sunforge Citadel & Northern Sun-Spire!
    // - On 'playing' / 'paused' / 'gameover': Damped third-person chase rig framing player + central arena vista!
    this.cameraTrauma = Math.max(0, this.cameraTrauma - dt * 1.8);
    const shakeMag = this.cameraTrauma * this.cameraTrauma * 0.42;
    const shakeX = (Math.random() - 0.5) * 2 * shakeMag;
    const shakeY = (Math.random() - 0.5) * 2 * shakeMag;

    if (this.shellState === 'title') {
      const orbitAng = elapsedSec * 0.16 + 0.55;
      _camDesired.set(
        Math.sin(orbitAng) * 29.5,
        12.5 + Math.sin(elapsedSec * 0.35) * 1.8,
        Math.cos(orbitAng) * 29.5
      );
      _camLookTarget.set(0, 2.4, -3.5);
      const damp = 1 - Math.exp(-4 * dt);
      this.camera.position.lerp(_camDesired, damp);
      this.currentLookAt.lerp(_camLookTarget, damp);
      this.camera.lookAt(this.currentLookAt);
    } else {
      const local = this.actors.get(this.localPlayerId);
      const px = local ? local.body.position.x : 0;
      const py = local ? Math.max(-2.5, local.body.position.y) : 1;
      const pz = local ? local.body.position.z : 12;

      _camDesired.set(px * 0.72, py + 10.2, pz + 14.2);
      _camLookTarget.set(px * 0.65, py + 1.4, pz - 3.6);

      const camDamp = 1 - Math.exp(-8.5 * dt);
      this.camera.position.lerp(_camDesired, camDamp);
      this.camera.position.x += shakeX;
      this.camera.position.y += shakeY;
      this.currentLookAt.lerp(_camLookTarget, camDamp);
      this.camera.lookAt(this.currentLookAt);

      // Subtle dynamic FOV kick when dashing!
      const speed = local
        ? Math.hypot(local.body.velocity.x, local.body.velocity.z)
        : 0;
      const targetFov = speed > 14 ? 61 : 56;
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-8 * dt));
        this.camera.updateProjectionMatrix();
      }
    }

    // Project 3D Actor Positions to 2D Screen Nameplates (guarded by z in [-1, 1], hidden on 'title')
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    for (const actor of this.actors.values()) {
      const domEl = this.nameplateRefs.get(actor.state.id);
      if (!domEl) continue;
      if (this.shellState === 'title') {
        domEl.style.opacity = '0';
        continue;
      }

      _projVec.set(
        actor.body.position.x,
        actor.body.position.y + 2.25,
        actor.body.position.z
      );
      _projVec.project(this.camera);

      if (_projVec.z >= -1 && _projVec.z <= 1) {
        const sx = (_projVec.x * 0.5 + 0.5) * width;
        const sy = (-_projVec.y * 0.5 + 0.5) * height;
        domEl.style.opacity = '1';
        domEl.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy)}px, 0) translate(-50%, -100%)`;
      } else {
        domEl.style.opacity = '0';
      }
    }
  }

  private pushHudSnapshot(): void {
    const local = this.actors.get(this.localPlayerId);
    const sorted = Array.from(this.actors.values())
      .map((a) => a.state)
      .sort((a, b) => b.score - a.score);

    this.callbacks.onHudUpdate({
      stability: local?.state.stability ?? 3,
      maxStability: local?.state.maxStability ?? 3,
      score: local?.state.score ?? 0,
      knockouts: local?.state.knockouts ?? 0,
      coreGoals: local?.state.coreGoals ?? 0,
      matchTimeRemaining: Math.ceil(this.matchTimeRemaining),
      dashReadyRatio: local
        ? Math.max(0, Math.min(1, 1 - local.state.dashCooldown / 1.65))
        : 1,
      shockwaveReadyRatio: local
        ? Math.max(0, Math.min(1, 1 - local.state.shockwaveCooldown / 2.6))
        : 1,
      leaderboard: sorted.map((p) => ({
        id: p.id,
        name: p.name,
        colorHex: p.colorHex,
        score: p.score,
        isLocal: p.id === this.localPlayerId,
      })),
    });
  }

  private afterDraw = (cb: () => void): void => {
    if (this.destroyed) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.destroyed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  };

  private scheduleNextTick(): void {
    if (this.destroyed) return;
    if (isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (): void => {
    if (this.destroyed) return;
    const now = performance.now();
    const rawDt = (now - this.lastPerfTime) / 1000;
    this.lastPerfTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05); // Clamped dt <= 0.05s

    // Hitstop pauses simulation physics briefly while camera shake, flashes & particles continue!
    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
    } else if (this.shellState === 'playing' || this.shellState === 'title') {
      const local = this.actors.get(this.localPlayerId);
      if (this.shellState === 'playing' && local) {
        this.stepLocalPlayerControls(local, dt);
      }

      if (this.role === 'client') {
        this.stepClientSimulation(dt);
      } else {
        // On 'title' screen, bots & physics play gently in the background showcase!
        this.stepHostSimulation(dt);
      }

      if (this.shellState === 'playing') {
        this.broadcastNetworkTick(dt);
      }
    }

    this.keysJustPressed.clear();
    this.pointerShockwaveQueued = false;

    this.particles.update(dt);
    this.syncVisualMeshesAndCamera(dt, now / 1000);

    // Throttle React HUD state updates to <= 10Hz
    this.hudSyncAccum += dt;
    if (this.hudSyncAccum >= 0.1) {
      this.hudSyncAccum = 0;
      if (this.shellState === 'playing') {
        this.pushHudSnapshot();
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.scheduleNextTick();
  };

  public triggerManualShockwaveFromHud(): void {
    if (this.shellState !== 'playing') return;
    const local = this.actors.get(this.localPlayerId);
    if (local) {
      arenaAudio.unlock();
      this.triggerShockwave(local, true);
    }
  }

  public destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clearHeldInputs);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.particles.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
