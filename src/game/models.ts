import * as THREE from 'three';
import travertineImgUrl from '../assets/images/sunlit_travertine_tile_1793608484626.jpg';
import bronzePlateImgUrl from '../assets/images/ornate_bronze_plate_1793608485574.jpg';

/**
 * Generates procedural grayscale bump/roughness micro-relief CanvasTextures
 * and radial contact shadow textures with zero external network dependencies.
 */
export function createStoneBumpTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#888888';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle tile mortar grooves + mineral grain
  ctx.strokeStyle = '#4c4c4c';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }

  for (let i = 0; i < 1600; i++) {
    const x = (i * 73) % 256;
    const y = (i * 137) % 256;
    const shade = 105 + ((i * 29) % 60);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    ctx.fillRect(x, y, 2, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}

let cachedShadowTex: THREE.CanvasTexture | null = null;
export function getRadialShadowTexture(): THREE.CanvasTexture {
  if (cachedShadowTex) return cachedShadowTex;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(10, 15, 28, 0.58)');
  grad.addColorStop(0.55, 'rgba(10, 15, 28, 0.24)');
  grad.addColorStop(1, 'rgba(10, 15, 28, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  cachedShadowTex = new THREE.CanvasTexture(canvas);
  cachedShadowTex.colorSpace = THREE.SRGBColorSpace;
  return cachedShadowTex;
}

export interface StrikerVisualRig {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  driveSphere: THREE.Mesh;
  telegraphRing: THREE.Mesh;
  shockwaveWave: THREE.Mesh;
  shadowDisc: THREE.Mesh;
  hullMaterial: THREE.MeshStandardMaterial;
  emissiveMaterial: THREE.MeshStandardMaterial;
  flashTimer: number;
  shockwaveAnim: number;
  baseColor: THREE.Color;
}

// Shared striker part geometries (created once, reused across all players & bots)
let sharedHullGeo: THREE.LatheGeometry | null = null;
let sharedPauldronGeo: THREE.ExtrudeGeometry | null = null;

function getSharedStrikerGeometries() {
  if (!sharedHullGeo) {
    const points = [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.52, 0.08),
      new THREE.Vector2(0.66, 0.38),
      new THREE.Vector2(0.62, 0.85),
      new THREE.Vector2(0.44, 1.16),
      new THREE.Vector2(0.0, 1.24),
    ];
    sharedHullGeo = new THREE.LatheGeometry(points, 20);
  }
  if (!sharedPauldronGeo) {
    const shape = new THREE.Shape();
    shape.moveTo(-0.22, -0.18);
    shape.lineTo(0.24, -0.14);
    shape.lineTo(0.18, 0.22);
    shape.lineTo(-0.18, 0.26);
    shape.closePath();
    sharedPauldronGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 2,
    });
  }
  return { hullGeo: sharedHullGeo, pauldronGeo: sharedPauldronGeo };
}

/**
 * Builds an 9-part Composite 3D Striker Rig (THREE.Group) pivoted cleanly at ground contact:
 * 1. Lathe-sculpted ceramic-enamel primary hull (roughness 0.38)
 * 2. Glossy obsidian visor dome (roughness 0.08, metalness 0.85)
 * 3. Luminous twin optic eyes (team accent emissive)
 * 4 & 5. Left & right beveled bronze pauldrons (roughness 0.28, metalness 0.82)
 * 6. Dorsal kinetic thruster pack + twin brass exhaust bells
 * 7. Rolling gyro-drive sphere beneath hull
 * 8. Crest halo antenna
 * 9. Ground contact shadow + telegraph charge ring
 */
export function createStrikerVisualRig(
  colorHex: string,
  enableShadows: boolean
): StrikerVisualRig {
  const { hullGeo, pauldronGeo } = getSharedStrikerGeometries();
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const baseColor = new THREE.Color(colorHex);

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.38,
    metalness: 0.18,
  });

  const bronzeTrimMat = new THREE.MeshStandardMaterial({
    color: 0xd4a359,
    roughness: 0.26,
    metalness: 0.84,
  });

  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.08,
    metalness: 0.88,
  });

  const emissiveMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: baseColor,
    emissiveIntensity: 1.6,
    roughness: 0.2,
  });

  // 1. Primary sculpted hull
  const hull = new THREE.Mesh(hullGeo, hullMaterial);
  hull.position.y = 0.38;
  hull.castShadow = enableShadows;
  hull.receiveShadow = enableShadows;
  bodyGroup.add(hull);

  // 2. Glossy visor dome (+Z forward)
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 18, 14),
    visorMat
  );
  visor.scale.set(1.05, 0.68, 0.72);
  visor.position.set(0, 1.08, 0.33);
  bodyGroup.add(visor);

  // 3. Twin luminous optic eyes
  const eyeGeo = new THREE.BoxGeometry(0.11, 0.055, 0.06);
  const leftEye = new THREE.Mesh(eyeGeo, emissiveMaterial);
  leftEye.position.set(-0.14, 1.1, 0.61);
  const rightEye = new THREE.Mesh(eyeGeo, emissiveMaterial);
  rightEye.position.set(0.14, 1.1, 0.61);
  bodyGroup.add(leftEye, rightEye);

  // 4 & 5. Beveled bronze shoulder pauldrons
  const leftPauldron = new THREE.Mesh(pauldronGeo, bronzeTrimMat);
  leftPauldron.position.set(-0.66, 0.96, -0.06);
  leftPauldron.rotation.y = Math.PI * 0.5;
  leftPauldron.castShadow = enableShadows;

  const rightPauldron = new THREE.Mesh(pauldronGeo, bronzeTrimMat);
  rightPauldron.position.set(0.52, 0.96, -0.06);
  rightPauldron.rotation.y = Math.PI * 0.5;
  rightPauldron.castShadow = enableShadows;
  bodyGroup.add(leftPauldron, rightPauldron);

  // 6. Dorsal kinetic thruster pack + twin exhaust nozzles
  const backpack = new THREE.Mesh(
    new THREE.BoxGeometry(0.56, 0.52, 0.32),
    bronzeTrimMat
  );
  backpack.position.set(0, 0.92, -0.52);
  backpack.castShadow = enableShadows;
  bodyGroup.add(backpack);

  const nozzleGeo = new THREE.CylinderGeometry(0.09, 0.13, 0.22, 12);
  const nozzleL = new THREE.Mesh(nozzleGeo, visorMat);
  nozzleL.position.set(-0.16, 0.72, -0.62);
  nozzleL.rotation.x = -0.35;
  const nozzleR = new THREE.Mesh(nozzleGeo, visorMat);
  nozzleR.position.set(0.16, 0.72, -0.62);
  nozzleR.rotation.x = -0.35;
  bodyGroup.add(nozzleL, nozzleR);

  // 7. Crest halo ring atop hull
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.035, 10, 20),
    bronzeTrimMat
  );
  halo.rotation.x = Math.PI * 0.5;
  halo.position.set(0, 1.72, 0);
  bodyGroup.add(halo);

  // 8. Gyro-drive sphere at base (rotates with travel distance)
  const driveSphere = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.38, 1),
    bronzeTrimMat
  );
  driveSphere.position.set(0, 0.38, 0);
  bodyGroup.add(driveSphere);

  // 9. Soft radial contact shadow + telegraph ring + expanding shockwave ring
  const shadowDisc = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 1.9),
    new THREE.MeshBasicMaterial({
      map: getRadialShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    })
  );
  shadowDisc.rotation.x = -Math.PI * 0.5;
  shadowDisc.position.y = 0.02;
  root.add(shadowDisc);

  const telegraphRing = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.18, 28),
    new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  telegraphRing.rotation.x = -Math.PI * 0.5;
  telegraphRing.position.y = 0.035;
  root.add(telegraphRing);

  const shockwaveWave = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1.15, 32),
    new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  shockwaveWave.rotation.x = -Math.PI * 0.5;
  shockwaveWave.position.y = 0.12;
  root.add(shockwaveWave);

  return {
    root,
    bodyGroup,
    driveSphere,
    telegraphRing,
    shockwaveWave,
    shadowDisc,
    hullMaterial,
    emissiveMaterial,
    flashTimer: 0,
    shockwaveAnim: 0,
    baseColor,
  };
}

export interface EnvironmentHandles {
  astrolabeRings: THREE.Mesh[];
  spireCrystal: THREE.Mesh;
  cloudInstanced: THREE.InstancedMesh;
  cloudBaseMatrices: THREE.Matrix4[];
  goalFields: THREE.Mesh[];
}

/**
 * Constructs the outdoor Sunforge Sky-Citadel island, tall northern Sun-Spire vista,
 * Radiant Goal Gates, drifting cloud sea, and distant monoliths.
 */
export function buildSkyCitadelEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  enableShadows: boolean
): EnvironmentHandles {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const texLoader = new THREE.TextureLoader();

  const travertineTex = texLoader.load(travertineImgUrl);
  travertineTex.colorSpace = THREE.SRGBColorSpace;
  travertineTex.wrapS = THREE.RepeatWrapping;
  travertineTex.wrapT = THREE.RepeatWrapping;
  travertineTex.repeat.set(7, 7);
  travertineTex.anisotropy = maxAniso;

  const bronzePlateTex = texLoader.load(bronzePlateImgUrl);
  bronzePlateTex.colorSpace = THREE.SRGBColorSpace;
  bronzePlateTex.wrapS = THREE.RepeatWrapping;
  bronzePlateTex.wrapT = THREE.RepeatWrapping;
  bronzePlateTex.repeat.set(1, 1);
  bronzePlateTex.anisotropy = maxAniso;

  const stoneBump = createStoneBumpTexture();

  // Main Octagonal Sky-Citadel Plaza Deck (top surface at Y = 0)
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: travertineTex,
    bumpMap: stoneBump,
    bumpScale: 0.04,
    roughness: 0.72,
    metalness: 0.06,
  });

  const deckGeo = new THREE.CylinderGeometry(24.5, 23.2, 2.2, 8);
  const deckMesh = new THREE.Mesh(deckGeo, deckMat);
  deckMesh.position.y = -1.1;
  deckMesh.rotation.y = Math.PI / 8;
  deckMesh.receiveShadow = enableShadows;
  scene.add(deckMesh);

  // Sculpted Tapered Cliff Underside (so the sky island feels massive & grounded in the sky)
  const cliffMat = new THREE.MeshStandardMaterial({
    color: 0x8c735b,
    roughness: 0.92,
    metalness: 0.05,
    flatShading: true,
  });
  const cliffUpper = new THREE.Mesh(
    new THREE.CylinderGeometry(22.4, 13.5, 9.0, 8),
    cliffMat
  );
  cliffUpper.position.y = -6.7;
  cliffUpper.rotation.y = Math.PI / 8;
  scene.add(cliffUpper);

  const cliffSpire = new THREE.Mesh(
    new THREE.ConeGeometry(13.2, 14.0, 7),
    cliffMat
  );
  cliffSpire.position.y = -18.2;
  cliffSpire.rotation.x = Math.PI;
  scene.add(cliffSpire);

  // Center Celestial Bronze Astrolabe Medallion (disjoint Y = +0.025 to prevent Z-fighting)
  const medallionMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: bronzePlateTex,
    roughness: 0.34,
    metalness: 0.78,
  });
  const medallion = new THREE.Mesh(
    new THREE.CylinderGeometry(7.2, 7.4, 0.05, 36),
    medallionMat
  );
  medallion.position.y = 0.025;
  medallion.receiveShadow = enableShadows;
  scene.add(medallion);

  // Perimeter Bronze Curb Rim Segments (with open ring-out gaps on East/West/Diagonal ledges!)
  const bronzeMat = new THREE.MeshStandardMaterial({
    color: 0xc89646,
    roughness: 0.3,
    metalness: 0.82,
  });
  const marbleMat = new THREE.MeshStandardMaterial({
    color: 0xf4ece1,
    bumpMap: stoneBump,
    bumpScale: 0.02,
    roughness: 0.58,
    metalness: 0.08,
  });

  // 4 Corner Balustrade Pillars (leave wide open ring-out drop-offs between them!)
  const cornerAngles = [
    Math.PI * 0.25,
    Math.PI * 0.75,
    Math.PI * 1.25,
    Math.PI * 1.75,
  ];
  for (const ang of cornerAngles) {
    const pillarGroup = new THREE.Group();
    const rx = Math.cos(ang) * 21.2;
    const rz = Math.sin(ang) * 21.2;
    pillarGroup.position.set(rx, 0, rz);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 0.7, 2.3),
      marbleMat
    );
    plinth.position.y = 0.35;
    plinth.castShadow = enableShadows;
    plinth.receiveShadow = enableShadows;

    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.68, 0.82, 4.2, 14),
      marbleMat
    );
    column.position.y = 2.8;
    column.castShadow = enableShadows;

    const brazierBowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 0.5, 0.55, 14),
      bronzeMat
    );
    brazierBowl.position.y = 5.15;

    const flameCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.52, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: 0xf59e0b,
        emissiveIntensity: 1.8,
        roughness: 0.2,
      })
    );
    flameCrystal.position.y = 5.85;

    pillarGroup.add(plinth, column, brazierBowl, flameCrystal);
    scene.add(pillarGroup);
  }

  // Two Radiant Goal Gates on West (X = -20.8) & East (X = +20.8) flanks — visible in wide view & zero camera occlusion!
  const goalFields: THREE.Mesh[] = [];
  const buildGoalGate = (xPos: number, accentHex: number) => {
    const gate = new THREE.Group();
    gate.position.set(xPos, 0, 0);
    gate.rotation.y = Math.PI * 0.5;

    const postGeo = new THREE.CylinderGeometry(0.52, 0.65, 4.8, 14);
    const leftPost = new THREE.Mesh(postGeo, bronzeMat);
    leftPost.position.set(-4.4, 2.4, 0);
    leftPost.castShadow = enableShadows;

    const rightPost = new THREE.Mesh(postGeo, bronzeMat);
    rightPost.position.set(4.4, 2.4, 0);
    rightPost.castShadow = enableShadows;

    const crossbar = new THREE.Mesh(
      new THREE.BoxGeometry(9.8, 0.68, 0.9),
      bronzeMat
    );
    crossbar.position.set(0, 4.9, 0);
    crossbar.castShadow = enableShadows;

    const archCrest = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.14, 10, 24),
      bronzeMat
    );
    archCrest.position.set(0, 6.1, 0);

    const fieldMat = new THREE.MeshBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const energyField = new THREE.Mesh(
      new THREE.PlaneGeometry(8.3, 4.5),
      fieldMat
    );
    energyField.position.set(0, 2.35, 0);
    goalFields.push(energyField);

    gate.add(leftPost, rightPost, crossbar, archCrest, energyField);
    scene.add(gate);
  };

  buildGoalGate(-20.8, 0x38bdf8);
  buildGoalGate(20.8, 0xfbbf24);

  // Tall Northern Sun-Spire Astrolabe Vista Landmark (Z = -34, framed right in spawn camera!)
  const spireGroup = new THREE.Group();
  spireGroup.position.set(0, -1.5, -36);

  const spireBaseRock = new THREE.Mesh(
    new THREE.ConeGeometry(6.8, 12, 7),
    cliffMat
  );
  spireBaseRock.position.y = -4.5;
  spireBaseRock.rotation.x = Math.PI;
  spireGroup.add(spireBaseRock);

  const spirePlinth = new THREE.Mesh(
    new THREE.CylinderGeometry(4.8, 5.6, 2.6, 8),
    marbleMat
  );
  spirePlinth.position.y = 2.6;
  spireGroup.add(spirePlinth);

  const obeliskL = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 11.5, 1.3),
    marbleMat
  );
  obeliskL.position.set(-2.8, 8.8, 0);
  const obeliskR = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 11.5, 1.3),
    marbleMat
  );
  obeliskR.position.set(2.8, 8.8, 0);
  spireGroup.add(obeliskL, obeliskR);

  const astrolabeRings: THREE.Mesh[] = [];
  const ringRadii = [4.4, 3.3, 2.2];
  ringRadii.forEach((r, idx) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.14, 12, 36),
      bronzeMat
    );
    ring.position.set(0, 12.2, 0);
    ring.rotation.set(idx * 0.5, idx * 0.8, 0);
    astrolabeRings.push(ring);
    spireGroup.add(ring);
  });

  const spireCrystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.25, 0),
    new THREE.MeshStandardMaterial({
      color: 0xfef9c3,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.0,
      roughness: 0.15,
    })
  );
  spireCrystal.position.set(0, 12.2, 0);
  spireGroup.add(spireCrystal);
  scene.add(spireGroup);

  // Drifting Sunlit Cloud Sea below the Sky Island (InstancedMesh, 48 puffs)
  const cloudCount = 48;
  const cloudGeo = new THREE.DodecahedronGeometry(4.2, 1);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
  });
  const cloudInstanced = new THREE.InstancedMesh(cloudGeo, cloudMat, cloudCount);
  cloudInstanced.frustumCulled = false;

  const cloudBaseMatrices: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  for (let i = 0; i < cloudCount; i++) {
    const angle = (i / cloudCount) * Math.PI * 2 + (i % 3) * 0.2;
    const radius = 28 + (i % 5) * 11;
    dummy.position.set(
      Math.cos(angle) * radius,
      -9.5 - (i % 4) * 2.4,
      Math.sin(angle) * radius
    );
    const s = 0.85 + ((i * 19) % 35) / 100;
    dummy.scale.set(s * 1.7, s * 0.58, s * 1.35);
    dummy.rotation.y = angle;
    dummy.updateMatrix();
    cloudInstanced.setMatrixAt(i, dummy.matrix);
    cloudBaseMatrices.push(dummy.matrix.clone());

    tint.setHSL(0.09, 0.25, 0.92 + ((i % 3) - 1) * 0.03);
    cloudInstanced.setColorAt(i, tint);
  }
  cloudInstanced.instanceMatrix.needsUpdate = true;
  if (cloudInstanced.instanceColor) cloudInstanced.instanceColor.needsUpdate = true;
  scene.add(cloudInstanced);

  // Distant Horizon Sky Monoliths (InstancedMesh, 14 monoliths)
  const monoCount = 14;
  const monoGeo = new THREE.ConeGeometry(3.8, 18, 6);
  const monoInstanced = new THREE.InstancedMesh(monoGeo, cliffMat, monoCount);
  for (let i = 0; i < monoCount; i++) {
    const ang = (i / monoCount) * Math.PI * 2 + 0.22;
    const dist = 62 + (i % 3) * 14;
    dummy.position.set(
      Math.cos(ang) * dist,
      -4 + (i % 4) * 2.5,
      Math.sin(ang) * dist
    );
    const scale = 0.85 + (i % 3) * 0.2;
    dummy.scale.set(scale, scale * 1.2, scale);
    dummy.rotation.set(Math.PI, ang, 0);
    dummy.updateMatrix();
    monoInstanced.setMatrixAt(i, dummy.matrix);
  }
  monoInstanced.computeBoundingSphere();
  scene.add(monoInstanced);

  return {
    astrolabeRings,
    spireCrystal,
    cloudInstanced,
    cloudBaseMatrices,
    goalFields,
  };
}

/**
 * Zero-GC Fixed-Capacity Pooled Particle Ring Buffer using a single THREE.InstancedMesh.
 */
export class PooledParticleSystem {
  public readonly mesh: THREE.InstancedMesh;
  private readonly capacity = 160;
  private cursor = 0;
  private readonly posX = new Float32Array(160);
  private readonly posY = new Float32Array(160);
  private readonly posZ = new Float32Array(160);
  private readonly velX = new Float32Array(160);
  private readonly velY = new Float32Array(160);
  private readonly velZ = new Float32Array(160);
  private readonly life = new Float32Array(160);
  private readonly maxLife = new Float32Array(160);
  private readonly baseScale = new Float32Array(160);
  private readonly scratchMat = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.OctahedronGeometry(0.16, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.frustumCulled = false;

    this.scratchScale.set(0, 0, 0);
    this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, this.scratchMat);
      this.mesh.setColorAt(i, this.scratchColor.setHex(0xfef08a));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  public burst(
    x: number,
    y: number,
    z: number,
    count: number,
    colorHex: string | number,
    speed = 7.5
  ): void {
    this.scratchColor.set(colorHex);
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      const theta = Math.random() * Math.PI * 2;
      const elev = 0.25 + Math.random() * 0.9;
      const spd = speed * (0.45 + Math.random() * 0.75);

      this.posX[idx] = x;
      this.posY[idx] = y;
      this.posZ[idx] = z;
      this.velX[idx] = Math.cos(theta) * spd;
      this.velY[idx] = elev * spd;
      this.velZ[idx] = Math.sin(theta) * spd;
      this.maxLife[idx] = 0.32 + Math.random() * 0.35;
      this.life[idx] = this.maxLife[idx];
      this.baseScale[idx] = 0.75 + Math.random() * 0.9;
      this.mesh.setColorAt(idx, this.scratchColor);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  public update(dt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      anyActive = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.scratchScale.set(0, 0, 0);
        this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
        this.mesh.setMatrixAt(i, this.scratchMat);
        continue;
      }

      this.velY[i] -= 16 * dt;
      this.posX[i] += this.velX[i] * dt;
      this.posY[i] += this.velY[i] * dt;
      this.posZ[i] += this.velZ[i] * dt;

      const ratio = this.life[i] / this.maxLife[i];
      const s = this.baseScale[i] * ratio;
      this.scratchPos.set(this.posX[i], this.posY[i], this.posZ[i]);
      this.scratchScale.set(s, s, s);
      this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.mesh.setMatrixAt(i, this.scratchMat);
    }
    if (anyActive) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
