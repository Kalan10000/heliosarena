import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_RADIUS,
  calculateShockwaveImpulse,
  checkMatchEnd,
  computeBotIntent,
  createFrozenMatchSummary,
  evaluateGoalZone,
  evaluateRingOut,
  generateRoomCode,
  interpolatePeerTransform,
  normalizeRoomCode,
  TARGET_VICTORY_SCORE,
  validateHostSetup,
  validateRoomJoinInput,
} from './rules';
import { PlayerSyncState } from './types';

function makePlayer(overrides: Partial<PlayerSyncState> = {}): PlayerSyncState {
  return {
    id: 'p1',
    name: 'Nova',
    colorHex: '#2563eb',
    isHost: true,
    isBot: false,
    position: { x: 0, y: 1, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
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
    ...overrides,
  };
}

test('room code generation and validation enforce clean inputs', () => {
  const code = generateRoomCode(() => 0.42);
  assert.equal(code.length, 5);
  assert.equal(normalizeRoomCode(' ab-92k '), 'AB92K');

  assert.equal(validateRoomJoinInput('', 'AB92K').valid, false);
  assert.equal(validateRoomJoinInput('Nova', '12').valid, false);
  const okJoin = validateRoomJoinInput('Nova', 'ab-92k');
  assert.equal(okJoin.valid, true);
  assert.equal(okJoin.normalizedCode, 'AB92K');

  assert.equal(validateHostSetup('A', 'Sky Citadel').valid, false);
  assert.equal(validateHostSetup('Nova', '').valid, false);
  assert.equal(validateHostSetup('Nova', 'Sky Citadel').valid, true);
});

test('shockwave impulse scales with distance and broken stability pips', () => {
  const freshHit = calculateShockwaveImpulse(
    { x: 0, y: 1, z: 0 },
    { x: 3, y: 1, z: 0 },
    3
  );
  const crackedHit = calculateShockwaveImpulse(
    { x: 0, y: 1, z: 0 },
    { x: 3, y: 1, z: 0 },
    0
  );
  const outOfRange = calculateShockwaveImpulse(
    { x: 0, y: 1, z: 0 },
    { x: 12, y: 1, z: 0 },
    3
  );

  assert.equal(freshHit.hit, true);
  assert.equal(crackedHit.hit, true);
  assert.ok(crackedHit.impulse.x > freshHit.impulse.x);
  assert.ok(freshHit.impulse.y > 0);
  assert.equal(outOfRange.hit, false);
});

test('ring-out KO credits attacker within credit window and ignores self/expired hits', () => {
  const credited = evaluateRingOut(
    {
      id: 'victim',
      position: { x: 10, y: -8, z: 10 },
      lastHitById: 'attacker-1',
      lastHitTimestamp: 5000,
    },
    9000
  );
  assert.equal(credited.isRingOut, true);
  assert.equal(credited.creditedAttackerId, 'attacker-1');
  assert.equal(credited.pointsAwarded, 2);

  const expired = evaluateRingOut(
    {
      id: 'victim',
      position: { x: 10, y: -8, z: 10 },
      lastHitById: 'attacker-1',
      lastHitTimestamp: 1000,
    },
    10000
  );
  assert.equal(expired.isRingOut, true);
  assert.equal(expired.creditedAttackerId, null);
  assert.equal(expired.pointsAwarded, 0);
});

test('solar core goal zone detects west and east radiant gates accurately', () => {
  assert.equal(evaluateGoalZone({ x: -21.4, y: 1.2, z: 0 }), 'west');
  assert.equal(evaluateGoalZone({ x: 21.3, y: 1.5, z: 2.5 }), 'east');
  assert.equal(evaluateGoalZone({ x: -21.4, y: 1.2, z: 8.5 }), null);
  assert.equal(evaluateGoalZone({ x: 0, y: 1.2, z: 0 }), null);
});

test('three distinct bot archetypes produce distinct tactical decisions and edge recovery', () => {
  const rival = makePlayer({ id: 'rival', position: { x: 4, y: 1, z: 0 } });

  // Edge recovery overrides when near sky-island drop-off
  const cliffBot = makePlayer({
    id: 'cliff-bot',
    isBot: true,
    archetype: 'rammer',
    position: { x: ARENA_RADIUS - 1.2, y: 1, z: 0 },
  });
  const cliffIntent = computeBotIntent({
    bot: cliffBot,
    rivals: [rival],
    solarCorePos: { x: 0, y: 1, z: 0 },
    activeShardPos: null,
    dt: 0.016,
    elapsedTime: 1,
  });
  assert.ok(cliffIntent.moveX < -0.8, 'bot near +X cliff steers inward (-X)');

  // Rammer builds telegraph before dashing at close rival
  const rammer = makePlayer({
    id: 'bot-rammer',
    isBot: true,
    archetype: 'rammer',
    position: { x: 0, y: 1, z: 0 },
    telegraphProgress: 0.9,
  });
  const ramIntent = computeBotIntent({
    bot: rammer,
    rivals: [rival],
    solarCorePos: { x: 0, y: 1, z: -8 },
    activeShardPos: null,
    dt: 0.1,
    elapsedTime: 2,
  });
  assert.equal(ramIntent.dash, true);

  // Warden charges shockwave when rival enters central zone
  const warden = makePlayer({
    id: 'bot-warden',
    isBot: true,
    archetype: 'warden',
    position: { x: 1, y: 1, z: 0 },
    telegraphProgress: 0.9,
  });
  const wardenIntent = computeBotIntent({
    bot: warden,
    rivals: [rival],
    solarCorePos: { x: 0, y: 1, z: -8 },
    activeShardPos: null,
    dt: 0.1,
    elapsedTime: 2,
  });
  assert.equal(wardenIntent.shockwave, true);
});

test('peer transform interpolation damps smoothly and snaps on respawn teleports', () => {
  const damped = interpolatePeerTransform(
    { x: 0, y: 1, z: 0 },
    0,
    { x: 2, y: 1, z: 0 },
    { x: 0, y: 0, z: 0 },
    Math.PI / 2,
    0.05
  );
  assert.ok(damped.position.x > 0.5 && damped.position.x < 2);
  assert.ok(damped.yaw > 0.2 && damped.yaw < Math.PI / 2);

  const snapped = interpolatePeerTransform(
    { x: 0, y: -9, z: 0 },
    0,
    { x: 0, y: 4, z: 12 },
    { x: 0, y: 0, z: 0 },
    1.2,
    0.016
  );
  assert.equal(snapped.position.z, 12);
  assert.equal(snapped.yaw, 1.2);
});

test('match end condition and frozen standings sort accurately', () => {
  const p1 = makePlayer({ id: 'p1', name: 'Host', score: 8, knockouts: 2 });
  const p2 = makePlayer({ id: 'p2', name: 'Guest', score: TARGET_VICTORY_SCORE, knockouts: 4 });

  assert.equal(checkMatchEnd([p1, p2], 90), true);
  assert.equal(checkMatchEnd([p1], 90), false);
  assert.equal(checkMatchEnd([p1], 0), true);

  const summary = createFrozenMatchSummary([p1, p2], 'p1', 65);
  assert.equal(summary.winnerId, 'p2');
  assert.equal(summary.isLocalVictory, false);
  assert.equal(summary.standings[0].name, 'Guest');
});
