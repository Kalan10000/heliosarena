export type GameShellState = 'title' | 'playing' | 'paused' | 'gameover';

export type NetworkRole = 'offline' | 'host' | 'client';

export type BotArchetype = 'rammer' | 'striker' | 'warden';

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface QuatTuple {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface PlayerSyncState {
  id: string;
  name: string;
  colorHex: string;
  isHost: boolean;
  isBot: boolean;
  archetype?: BotArchetype;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  yaw: number;
  stability: number; // 0..3 shield pips (lower stability = higher knockback multiplier!)
  maxStability: number;
  score: number;
  knockouts: number;
  coreGoals: number;
  dashCooldown: number;
  shockwaveCooldown: number;
  telegraphProgress: number; // 0..1 windup visual cue
  lastHitById: string | null;
  lastHitTimestamp: number;
}

export interface PropSyncState {
  id: string;
  kind: 'crate' | 'bumper';
  position: Vec3Tuple;
  quaternion: QuatTuple;
  velocity: Vec3Tuple;
}

export interface SolarCoreSyncState {
  position: Vec3Tuple;
  quaternion: QuatTuple;
  velocity: Vec3Tuple;
  lastTouchPlayerId: string | null;
}

export interface ShardSyncState {
  id: string;
  position: Vec3Tuple;
  active: boolean;
  respawnTimer: number;
}

export interface WorldSnapshotPacket {
  type: 'world-snapshot';
  seq: number;
  timestamp: number;
  matchTimeRemaining: number;
  players: PlayerSyncState[];
  solarCore: SolarCoreSyncState;
  props: PropSyncState[];
  shards: ShardSyncState[];
}

export interface ClientInputPacket {
  type: 'client-state';
  seq: number;
  timestamp: number;
  playerId: string;
  name: string;
  colorHex: string;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  yaw: number;
  dashJustTriggered: boolean;
  shockwaveJustTriggered: boolean;
}

export interface ArenaEventPacket {
  type: 'arena-event';
  eventKind: 'shockwave' | 'dash' | 'knockout' | 'core-goal' | 'shard-pickup' | 'match-reset' | 'match-end';
  actorId: string;
  actorName: string;
  targetName?: string;
  position: Vec3Tuple;
  pointsAwarded?: number;
  summary?: FrozenMatchSummary;
}

export interface PeerPingPacket {
  type: 'ping' | 'pong';
  sentAt: number;
}

export interface RoomRosterPacket {
  type: 'room-roster';
  roomId: string;
  roomName: string;
  hostId: string;
  botCount: number;
  peers: Array<{ id: string; name: string; colorHex: string; rttMs: number }>;
}

export type ReliableDataPacket = ArenaEventPacket | PeerPingPacket | RoomRosterPacket;
export type FastDataPacket = WorldSnapshotPacket | ClientInputPacket;

export interface PublicRoomListing {
  roomId: string;
  roomName: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  botCount: number;
  arenaName: string;
  status: 'open' | 'in-match';
  updatedAt: number;
  transport: 'global-wss' | 'local-tab';
}

export interface ConnectedPeerInfo {
  peerId: string;
  name: string;
  colorHex: string;
  connectionState: RTCPeerConnectionState;
  dataChannelOpen: boolean;
  rttMs: number;
}

export interface FeedEventItem {
  id: string;
  message: string;
  accentColor: string;
  createdAt: number;
}

export interface FrozenPlayerStanding {
  id: string;
  name: string;
  colorHex: string;
  isBot: boolean;
  isLocal: boolean;
  score: number;
  knockouts: number;
  coreGoals: number;
}

export interface FrozenMatchSummary {
  winnerId: string;
  winnerName: string;
  winnerColor: string;
  isLocalVictory: boolean;
  matchDurationSec: number;
  localScore: number;
  localKnockouts: number;
  localCoreGoals: number;
  standings: FrozenPlayerStanding[];
}

export interface HudSnapshot {
  stability: number;
  maxStability: number;
  score: number;
  knockouts: number;
  coreGoals: number;
  matchTimeRemaining: number;
  dashReadyRatio: number; // 0..1
  shockwaveReadyRatio: number; // 0..1
  leaderboard: Array<{
    id: string;
    name: string;
    colorHex: string;
    score: number;
    isLocal: boolean;
  }>;
}
