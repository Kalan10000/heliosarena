import {
  BotArchetype,
  FrozenMatchSummary,
  PlayerSyncState,
  Vec3Tuple,
} from './types';

export const ARENA_RADIUS = 24.5;
export const RING_OUT_Y = -6.5;
export const GOAL_WEST_X = -20.8;
export const GOAL_EAST_X = 20.8;
export const GOAL_HALF_WIDTH = 4.2;
export const GOAL_HEIGHT = 4.6;
export const MATCH_DURATION_SECONDS = 150;
export const TARGET_VICTORY_SCORE = 12;
export const HIT_CREDIT_WINDOW_MS = 6500;

export const PLAYER_PALETTE = [
  '#2563eb', // Cobalt Azure
  '#dc2626', // Vermilion Crimson
  '#059669', // Sunlit Emerald
  '#d97706', // Imperial Amber
  '#7c3aed', // Royal Amethyst
  '#0d9488', // Aegean Teal
];

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(randomFn: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    const idx = Math.floor(randomFn() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length;
    code += ROOM_ALPHABET[idx];
  }
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  normalizedCallsign?: string;
  normalizedCode?: string;
  normalizedRoomName?: string;
}

export function validateHostSetup(callsign: string, roomName: string): ValidationResult {
  const trimmedName = callsign.trim();
  if (trimmedName.length < 2) {
    return { valid: false, error: 'Enter a callsign of at least 2 characters.' };
  }
  if (trimmedName.length > 16) {
    return { valid: false, error: 'Callsign must be 16 characters or fewer.' };
  }
  const trimmedRoom = roomName.trim();
  if (trimmedRoom.length < 2) {
    return { valid: false, error: 'Enter a room title of at least 2 characters.' };
  }
  return {
    valid: true,
    normalizedCallsign: trimmedName,
    normalizedRoomName: trimmedRoom.slice(0, 28),
  };
}

export function validateRoomJoinInput(callsign: string, roomCode: string): ValidationResult {
  const trimmedName = callsign.trim();
  if (trimmedName.length < 2) {
    return { valid: false, error: 'Enter a callsign of at least 2 characters before joining.' };
  }
  const cleanCode = normalizeRoomCode(roomCode);
  if (cleanCode.length < 4 || cleanCode.length > 8) {
    return { valid: false, error: 'Enter a valid 4–8 character room code.' };
  }
  return {
    valid: true,
    normalizedCallsign: trimmedName.slice(0, 16),
    normalizedCode: cleanCode,
  };
}

export interface ShockwaveImpulseResult {
  hit: boolean;
  impulse: Vec3Tuple;
  stabilityDamage: number;
}

/**
 * Computes radial knockback impulse for Cannon.js bodies when a player fires a Shockwave Pulse.
 * Lower target stability (cracked shields) increases knockback launch distance, Smash-style!
 */
export function calculateShockwaveImpulse(
  origin: Vec3Tuple,
  target: Vec3Tuple,
  targetStability: number,
  maxRadius = 6.8,
  baseForce = 18.5
): ShockwaveImpulseResult {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq > maxRadius * maxRadius || distSq < 0.0001) {
    const flatDist = Math.hypot(dx, dz);
    if (flatDist === 0 && Math.abs(dy) < 0.5) {
      return {
        hit: true,
        impulse: { x: 0, y: baseForce * 0.55, z: baseForce },
        stabilityDamage: 1,
      };
    }
    return { hit: false, impulse: { x: 0, y: 0, z: 0 }, stabilityDamage: 0 };
  }

  const dist = Math.sqrt(distSq);
  const falloff = Math.max(0.28, 1 - dist / maxRadius);
  const brokenShieldMultiplier = 1 + Math.max(0, 3 - targetStability) * 0.32;
  const magnitude = baseForce * falloff * brokenShieldMultiplier;

  const horizLen = Math.hypot(dx, dz) || 1;
  const nx = dx / horizLen;
  const nz = dz / horizLen;

  return {
    hit: true,
    impulse: {
      x: nx * magnitude,
      y: Math.min(11.5, 4.6 + magnitude * 0.28),
      z: nz * magnitude,
    },
    stabilityDamage: dist < maxRadius * 0.65 ? 1 : 0,
  };
}

export interface RingOutOutcome {
  isRingOut: boolean;
  creditedAttackerId: string | null;
  pointsAwarded: number;
}

export function evaluateRingOut(
  victim: Pick<PlayerSyncState, 'id' | 'position' | 'lastHitById' | 'lastHitTimestamp'>,
  nowMs: number
): RingOutOutcome {
  if (victim.position.y > RING_OUT_Y) {
    return { isRingOut: false, creditedAttackerId: null, pointsAwarded: 0 };
  }
  const hasValidCredit =
    victim.lastHitById !== null &&
    victim.lastHitById !== victim.id &&
    nowMs - victim.lastHitTimestamp <= HIT_CREDIT_WINDOW_MS;

  return {
    isRingOut: true,
    creditedAttackerId: hasValidCredit ? victim.lastHitById : null,
    pointsAwarded: hasValidCredit ? 2 : 0,
  };
}

export type GoalSide = 'west' | 'east' | null;

export function evaluateGoalZone(corePos: Vec3Tuple): GoalSide {
  if (
    Math.abs(corePos.z) <= GOAL_HALF_WIDTH &&
    corePos.y >= -0.6 &&
    corePos.y <= GOAL_HEIGHT
  ) {
    if (corePos.x <= GOAL_WEST_X) return 'west';
    if (corePos.x >= GOAL_EAST_X) return 'east';
  }
  return null;
}

export function shortestAngleDelta(fromRad: number, toRad: number): number {
  let diff = (toRad - fromRad) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export function interpolatePeerTransform(
  currentPos: Vec3Tuple,
  currentYaw: number,
  targetPos: Vec3Tuple,
  targetVel: Vec3Tuple,
  targetYaw: number,
  dt: number,
  dampingLambda = 16
): { position: Vec3Tuple; yaw: number } {
  const clampedDt = Math.min(Math.max(dt, 0), 0.1);
  // Subtle velocity lead capped to avoid overshoot
  const leadDt = Math.min(clampedDt * 0.5, 0.025);
  const goalX = targetPos.x + targetVel.x * leadDt;
  const goalY = targetPos.y + targetVel.y * leadDt;
  const goalZ = targetPos.z + targetVel.z * leadDt;

  // Snap if teleported (e.g., respawn after ring-out)
  const distSq =
    (goalX - currentPos.x) ** 2 +
    (goalY - currentPos.y) ** 2 +
    (goalZ - currentPos.z) ** 2;

  if (distSq > 64) {
    return {
      position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      yaw: targetYaw,
    };
  }

  const alpha = 1 - Math.exp(-dampingLambda * clampedDt);
  const nextYaw = currentYaw + shortestAngleDelta(currentYaw, targetYaw) * alpha;

  return {
    position: {
      x: currentPos.x + (goalX - currentPos.x) * alpha,
      y: currentPos.y + (goalY - currentPos.y) * alpha,
      z: currentPos.z + (goalZ - currentPos.z) * alpha,
    },
    yaw: nextYaw,
  };
}

export interface BotIntent {
  moveX: number;
  moveZ: number;
  desiredYaw: number;
  jump: boolean;
  dash: boolean;
  shockwave: boolean;
  nextTelegraph: number;
}

/**
 * Implements 3 genuinely distinct enemy/bot movement & decision policies:
 * 1. 'rammer': Locks onto nearest rival, telegraphs a 0.45s crouch-charge, then dashes to ring them out.
 * 2. 'striker': Plays the objective — approaches behind the Solar Core to drive it into a Radiant Goal Gate.
 * 3. 'warden': Patrols elevated center astrolabe ring & shards, unleashing telegraphed area-denial shockwaves.
 */
export function computeBotIntent(params: {
  bot: PlayerSyncState;
  rivals: PlayerSyncState[];
  solarCorePos: Vec3Tuple;
  activeShardPos: Vec3Tuple | null;
  dt: number;
  elapsedTime: number;
}): BotIntent {
  const { bot, rivals, solarCorePos, activeShardPos, dt, elapsedTime } = params;
  const pos = bot.position;
  const distFromCenter = Math.hypot(pos.x, pos.z);

  // Universal Sky-Island Edge Recovery: steer inward if near cliff perimeter!
  if (distFromCenter > ARENA_RADIUS - 3.6) {
    const inwardX = -pos.x / (distFromCenter || 1);
    const inwardZ = -pos.z / (distFromCenter || 1);
    return {
      moveX: inwardX,
      moveZ: inwardZ,
      desiredYaw: Math.atan2(inwardX, inwardZ),
      jump: pos.y < 0.2,
      dash: distFromCenter > ARENA_RADIUS - 2.0 && bot.dashCooldown <= 0,
      shockwave: false,
      nextTelegraph: 0,
    };
  }

  const archetype: BotArchetype = bot.archetype ?? 'striker';

  if (archetype === 'rammer') {
    let nearest: PlayerSyncState | null = null;
    let bestDist = Infinity;
    for (const r of rivals) {
      if (r.id === bot.id || r.position.y < -2) continue;
      const d = Math.hypot(r.position.x - pos.x, r.position.z - pos.z);
      if (d < bestDist) {
        bestDist = d;
        nearest = r;
      }
    }

    if (!nearest) {
      return {
        moveX: 0,
        moveZ: 0,
        desiredYaw: bot.yaw,
        jump: false,
        dash: false,
        shockwave: false,
        nextTelegraph: 0,
      };
    }

    const dx = nearest.position.x - pos.x;
    const dz = nearest.position.z - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;
    const yaw = Math.atan2(dirX, dirZ);

    // Telegraph windup before heavy dash-ram when within 7.5m
    if (bestDist < 7.5 && bot.dashCooldown <= 0) {
      const nextTel = bot.telegraphProgress + dt / 0.45;
      if (nextTel >= 1) {
        return {
          moveX: dirX,
          moveZ: dirZ,
          desiredYaw: yaw,
          jump: false,
          dash: true,
          shockwave: false,
          nextTelegraph: 0,
        };
      }
      // Pause movement slightly during crouch telegraph so player can read & dodge!
      return {
        moveX: dirX * 0.25,
        moveZ: dirZ * 0.25,
        desiredYaw: yaw,
        jump: false,
        dash: false,
        shockwave: false,
        nextTelegraph: nextTel,
      };
    }

    return {
      moveX: dirX,
      moveZ: dirZ,
      desiredYaw: yaw,
      jump: false,
      dash: false,
      shockwave: false,
      nextTelegraph: Math.max(0, bot.telegraphProgress - dt * 2),
    };
  }

  if (archetype === 'striker') {
    // Line up behind the Solar Core relative to the nearest Radiant Goal Gate (West X = -20.8 or East X = +20.8)
    const targetGoalX = solarCorePos.x <= 0 ? GOAL_WEST_X : GOAL_EAST_X;
    const coreToGoalX = targetGoalX - solarCorePos.x;
    const coreToGoalZ = 0 - solarCorePos.z;
    const cgLen = Math.hypot(coreToGoalX, coreToGoalZ) || 1;

    // Approach point slightly behind core so striker pushes it toward the goal gate
    const behindCoreX = solarCorePos.x - (coreToGoalX / cgLen) * 1.3;
    const behindCoreZ = solarCorePos.z - (coreToGoalZ / cgLen) * 1.3;

    const distToCore = Math.hypot(solarCorePos.x - pos.x, solarCorePos.z - pos.z);
    const goalX = distToCore < 2.6 ? solarCorePos.x : behindCoreX;
    const goalZ = distToCore < 2.6 ? solarCorePos.z : behindCoreZ;

    const dx = goalX - pos.x;
    const dz = goalZ - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;

    return {
      moveX: dirX,
      moveZ: dirZ,
      desiredYaw: Math.atan2(dirX, dirZ),
      jump: false,
      dash: distToCore < 2.8 && bot.dashCooldown <= 0,
      shockwave: false,
      nextTelegraph: 0,
    };
  }

  // 'warden': Orbits the central Bronze Astrolabe / active shards and uses telegraphed area-denial Shockwave
  const orbitAngle = elapsedTime * 0.75 + (bot.id.charCodeAt(0) % 5);
  const patrolTarget = activeShardPos ?? {
    x: Math.cos(orbitAngle) * 6.5,
    y: 0,
    z: Math.sin(orbitAngle) * 6.5,
  };

  let closeRivalDist = Infinity;
  for (const r of rivals) {
    if (r.id === bot.id || r.position.y < -2) continue;
    const d = Math.hypot(r.position.x - pos.x, r.position.z - pos.z);
    if (d < closeRivalDist) closeRivalDist = d;
  }

  const dx = patrolTarget.x - pos.x;
  const dz = patrolTarget.z - pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const dirX = len > 0.6 ? dx / len : 0;
  const dirZ = len > 0.6 ? dz / len : 0;

  if (closeRivalDist < 5.4 && bot.shockwaveCooldown <= 0) {
    const nextTel = bot.telegraphProgress + dt / 0.5;
    if (nextTel >= 1) {
      return {
        moveX: 0,
        moveZ: 0,
        desiredYaw: bot.yaw,
        jump: false,
        dash: false,
        shockwave: true,
        nextTelegraph: 0,
      };
    }
    return {
      moveX: dirX * 0.2,
      moveZ: dirZ * 0.2,
      desiredYaw: Math.atan2(dirX || 0.01, dirZ || 1),
      jump: false,
      dash: false,
      shockwave: false,
      nextTelegraph: nextTel,
    };
  }

  return {
    moveX: dirX,
    moveZ: dirZ,
    desiredYaw: Math.atan2(dirX || 0.01, dirZ || 1),
    jump: false,
    dash: false,
    shockwave: false,
    nextTelegraph: Math.max(0, bot.telegraphProgress - dt * 2),
  };
}

export function checkMatchEnd(
  players: PlayerSyncState[],
  matchTimeRemaining: number
): boolean {
  if (matchTimeRemaining <= 0) return true;
  return players.some((p) => p.score >= TARGET_VICTORY_SCORE);
}

export function createFrozenMatchSummary(
  players: PlayerSyncState[],
  localPlayerId: string,
  elapsedSec: number
): FrozenMatchSummary {
  const sorted = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.knockouts !== a.knockouts) return b.knockouts - a.knockouts;
    return b.coreGoals - a.coreGoals;
  });

  const winner = sorted[0] ?? {
    id: localPlayerId,
    name: 'Striker',
    colorHex: PLAYER_PALETTE[0],
    score: 0,
    knockouts: 0,
    coreGoals: 0,
  };
  const local = players.find((p) => p.id === localPlayerId);

  return {
    winnerId: winner.id,
    winnerName: winner.name,
    winnerColor: winner.colorHex,
    isLocalVictory: winner.id === localPlayerId,
    matchDurationSec: Math.max(1, Math.round(elapsedSec)),
    localScore: local?.score ?? 0,
    localKnockouts: local?.knockouts ?? 0,
    localCoreGoals: local?.coreGoals ?? 0,
    standings: sorted.map((p) => ({
      id: p.id,
      name: p.name,
      colorHex: p.colorHex,
      isBot: p.isBot,
      isLocal: p.id === localPlayerId,
      score: p.score,
      knockouts: p.knockouts,
      coreGoals: p.coreGoals,
    })),
  };
}
