import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArenaEngine,
  NameplateDomHandle,
} from './game/ArenaEngine';
import { HeliosWebRtcNetwork } from './network/webrtcMesh';
import {
  ConnectedPeerInfo,
  FeedEventItem,
  FrozenMatchSummary,
  GameShellState,
  HudSnapshot,
  NetworkRole,
  PublicRoomListing,
} from './game/types';
import {
  generateRoomCode,
  MATCH_DURATION_SECONDS,
  normalizeRoomCode,
  PLAYER_PALETTE,
} from './game/rules';
import { arenaAudio } from './game/audio';
import { TitleOverlay } from './components/TitleOverlay';
import { GameHud } from './components/GameHud';
import { StatusModal } from './components/StatusModal';

const INITIAL_HUD: HudSnapshot = {
  stability: 3,
  maxStability: 3,
  score: 0,
  knockouts: 0,
  coreGoals: 0,
  matchTimeRemaining: MATCH_DURATION_SECONDS,
  dashReadyRatio: 1,
  shockwaveReadyRatio: 1,
  leaderboard: [],
};

export default function App() {
  const initialParams = useMemo(() => {
    if (typeof window === 'undefined') {
      return { autostart: false, roomCode: '' };
    }
    const sp = new URLSearchParams(window.location.search);
    return {
      autostart: sp.get('autostart') === '1',
      roomCode: normalizeRoomCode(sp.get('room') ?? ''),
    };
  }, []);

  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const nameplateRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const engineRef = useRef<ArenaEngine | null>(null);
  const networkRef = useRef<HeliosWebRtcNetwork | null>(null);

  const [shellState, setShellState] = useState<GameShellState>(() =>
    initialParams.autostart ? 'playing' : 'title'
  );
  const shellStateRef = useRef<GameShellState>(shellState);

  const [role, setRole] = useState<NetworkRole>('offline');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string>('Sunforge Clash');
  const [inviteUrl, setInviteUrl] = useState<string>('');
  const [botCount, setBotCount] = useState<number>(2);

  const [rooms, setRooms] = useState<PublicRoomListing[]>([]);
  const [peers, setPeers] = useState<ConnectedPeerInfo[]>([]);
  const [signalingConnected, setSignalingConnected] = useState<boolean>(false);
  const [signalingLabel, setSignalingLabel] = useState<string>('Scanning Lobby');
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [nameplates, setNameplates] = useState<NameplateDomHandle[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEventItem[]>([]);
  const [matchSummary, setMatchSummary] = useState<FrozenMatchSummary | null>(null);
  const [muted, setMuted] = useState<boolean>(false);

  const pushFeedEvent = useCallback((message: string, accentColor: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFeedEvents((prev) => [...prev.slice(-3), { id, message, accentColor, createdAt: Date.now() }]);
    window.setTimeout(() => {
      setFeedEvents((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const applyShellTransition = useCallback((next: GameShellState) => {
    shellStateRef.current = next;
    setShellState(next);
    document.body.dataset.state = next;
    engineRef.current?.setShellState(next);
  }, []);

  // Initialize isolated WebGL Engine + WebRTC P2P Network ONCE (`useEffect(..., [])`)
  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    const net = new HeliosWebRtcNetwork({
      onRoomsUpdated: (list) => setRooms(list),
      onPeersUpdated: (peerList) => setPeers(peerList),
      onFastPacket: (fromPeerId, packet) => {
        engineRef.current?.handleIncomingFastPacket(fromPeerId, packet);
      },
      onReliablePacket: (fromPeerId, packet) => {
        engineRef.current?.handleIncomingReliablePacket(fromPeerId, packet);
      },
      onPeerConnected: (peerId, name, colorHex) => {
        engineRef.current?.handlePeerConnected(peerId, name, colorHex);
        pushFeedEvent(`${name} connected via WebRTC P2P!`, colorHex);
      },
      onPeerDisconnected: (peerId, name) => {
        engineRef.current?.handlePeerDisconnected(peerId);
        pushFeedEvent(`${name} disconnected`, '#94a3b8');
      },
      onSignalingStatus: (connected, label) => {
        setSignalingConnected(connected);
        setSignalingLabel(label);
      },
      onJoinConnectedToHost: (joinedRoomId, joinedRoomName) => {
        setJoiningRoomId(null);
        setJoinError(null);
        setRoomId(joinedRoomId);
        setRoomName(joinedRoomName);
        setRole('client');
        setInviteUrl(net.buildInviteUrl());
        applyShellTransition('playing');
      },
      onJoinError: (msg) => {
        setJoiningRoomId(null);
        setJoinError(msg);
      },
    });
    networkRef.current = net;

    const engine = new ArenaEngine(mountEl, nameplateRefsMap.current, {
      onHudUpdate: (nextHud) => setHud(nextHud),
      onFeedEvent: (msg, color) => pushFeedEvent(msg, color),
      onMatchFinished: (summary) => {
        setMatchSummary(summary);
        shellStateRef.current = 'gameover';
        setShellState('gameover');
      },
      onNameplatesChanged: (items) => setNameplates(items),
      sendFastPacket: (pkt) => net.broadcastFast(pkt),
      sendReliablePacket: (pkt) => net.broadcastReliable(pkt),
    });
    engineRef.current = engine;

    if (initialParams.autostart) {
      const code = generateRoomCode();
      net.hostRoom({
        roomId: code,
        roomName: 'Sunforge Clash',
        hostName: 'Nova',
        colorHex: PLAYER_PALETTE[0],
        botCount: 2,
      });
      engine.configureSession({
        role: 'host',
        localPlayerId: net.localPeerId,
        localName: 'Nova',
        localColor: PLAYER_PALETTE[0],
        botCount: 2,
      });
      setRole('host');
      setRoomId(code);
      setInviteUrl(net.buildInviteUrl());
      engine.setShellState('playing');
      document.body.dataset.state = 'playing';
    } else {
      engine.setShellState('title');
      document.body.dataset.state = 'title';
    }

    return () => {
      engine.destroy();
      net.destroy();
      engineRef.current = null;
      networkRef.current = null;
    };
  }, [applyShellTransition, initialParams.autostart, pushFeedEvent]);

  const handleHostRoom = useCallback(
    (params: {
      callsign: string;
      roomName: string;
      colorHex: string;
      botCount: number;
    }) => {
      arenaAudio.unlock();
      const net = networkRef.current;
      const engine = engineRef.current;
      if (!net || !engine) return;

      const newRoomCode = generateRoomCode();
      net.hostRoom({
        roomId: newRoomCode,
        roomName: params.roomName,
        hostName: params.callsign,
        colorHex: params.colorHex,
        botCount: params.botCount,
      });

      engine.configureSession({
        role: 'host',
        localPlayerId: net.localPeerId,
        localName: params.callsign,
        localColor: params.colorHex,
        botCount: params.botCount,
      });

      setRole('host');
      setRoomId(newRoomCode);
      setRoomName(params.roomName);
      setBotCount(params.botCount);
      setInviteUrl(net.buildInviteUrl());
      setMatchSummary(null);
      applyShellTransition('playing');
      pushFeedEvent(
        `Room ${newRoomCode} live! Friends can join from Open Rooms.`,
        '#f59e0b'
      );
    },
    [applyShellTransition, pushFeedEvent]
  );

  const handleJoinRoom = useCallback(
    (params: { callsign: string; roomCode: string; colorHex: string }) => {
      arenaAudio.unlock();
      const net = networkRef.current;
      const engine = engineRef.current;
      if (!net || !engine) return;

      setJoiningRoomId(params.roomCode);
      setJoinError(null);

      engine.configureSession({
        role: 'client',
        localPlayerId: net.localPeerId,
        localName: params.callsign,
        localColor: params.colorHex,
        botCount: 0,
      });

      net.joinRoom({
        roomId: params.roomCode,
        playerName: params.callsign,
        colorHex: params.colorHex,
      });
    },
    []
  );

  const handleStartSolo = useCallback(
    (params: { callsign: string; colorHex: string; botCount: number }) => {
      arenaAudio.unlock();
      const net = networkRef.current;
      const engine = engineRef.current;
      if (!net || !engine) return;

      net.startSolo({
        playerName: params.callsign,
        colorHex: params.colorHex,
        botCount: params.botCount,
      });
      engine.configureSession({
        role: 'offline',
        localPlayerId: net.localPeerId,
        localName: params.callsign,
        localColor: params.colorHex,
        botCount: params.botCount,
      });

      setRole('offline');
      setRoomId(null);
      setInviteUrl('');
      setBotCount(params.botCount);
      setMatchSummary(null);
      applyShellTransition('playing');
    },
    [applyShellTransition]
  );

  const handleRestartMatch = useCallback(() => {
    arenaAudio.unlock();
    setMatchSummary(null);
    engineRef.current?.resetMatchState(true);
    applyShellTransition('playing');
  }, [applyShellTransition]);

  const handleReturnToTitle = useCallback(() => {
    networkRef.current?.leaveRoom();
    setRole('offline');
    setRoomId(null);
    setInviteUrl('');
    setJoiningRoomId(null);
    setMatchSummary(null);
    if (networkRef.current && engineRef.current) {
      engineRef.current.configureSession({
        role: 'offline',
        localPlayerId: networkRef.current.localPeerId,
        localName: 'Nova',
        localColor: PLAYER_PALETTE[0],
        botCount: 2,
      });
    }
    applyShellTransition('title');
  }, [applyShellTransition]);

  const handleChangeBotCount = useCallback((count: number) => {
    setBotCount(count);
    engineRef.current?.setBotCount(count);
    networkRef.current?.setBotCount(count);
  }, []);

  const handleToggleMute = useCallback(() => {
    const next = arenaAudio.toggleMute();
    setMuted(next);
  }, []);

  // Global Shell Keyboard Shortcuts:
  // - Enter/Space on 'title' (outside inputs/buttons) -> Start Host Room
  // - Escape / P -> Toggle 'playing' <-> 'paused'
  // - M -> Toggle Mute
  // - R -> Restart Match (when playing as host/solo)
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (shellStateRef.current === 'title') {
        if (!inInput && tag !== 'BUTTON' && (e.code === 'Enter' || e.code === 'Space')) {
          e.preventDefault();
          const startBtn = document.querySelector<HTMLButtonElement>('[data-start="true"]');
          startBtn?.click();
        }
        return;
      }

      if (inInput) return;

      if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault();
        if (shellStateRef.current === 'playing') {
          applyShellTransition('paused');
        } else if (shellStateRef.current === 'paused') {
          applyShellTransition('playing');
        }
      } else if (e.code === 'KeyM') {
        handleToggleMute();
      } else if (
        e.code === 'KeyR' &&
        shellStateRef.current === 'playing' &&
        networkRef.current?.getRole() !== 'client'
      ) {
        handleRestartMatch();
      }
    };

    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [applyShellTransition, handleRestartMatch, handleToggleMute]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0c1220]">
      {/* Dedicated Empty Ref Container for Three.js WebGLRenderer */}
      <div
        ref={canvasMountRef}
        className="fixed inset-0 w-full h-full"
        aria-hidden="true"
      />

      {/* World-Projected 3D Player Nameplates (Updated at 60Hz via direct DOM refs, zero React re-renders) */}
      <div className="fixed inset-0 pointer-events-none z-10 overflow-hidden" aria-hidden="true">
        {nameplates.map((np) => (
          <div
            key={np.id}
            ref={(el) => {
              if (el) nameplateRefsMap.current.set(np.id, el);
              else nameplateRefsMap.current.delete(np.id);
            }}
            className="absolute top-0 left-0 px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap transition-opacity duration-75"
            style={{
              opacity: 0,
              backgroundColor: 'rgba(11, 17, 32, 0.82)',
              color: np.isLocal ? '#fef08a' : '#f8fafc',
              borderBottom: `2px solid ${np.colorHex}`,
            }}
          >
            {np.name}
          </div>
        ))}
      </div>

      {/* Title Screen & Live WebRTC Room Browser */}
      {shellState === 'title' && (
        <TitleOverlay
          defaultCallsign={initialParams.roomCode ? 'Zephyr' : 'Nova'}
          defaultRoomCode={initialParams.roomCode}
          signalingLabel={signalingLabel}
          signalingConnected={signalingConnected}
          rooms={rooms}
          joinError={joinError}
          joiningRoomId={joiningRoomId}
          onClearJoinError={() => setJoinError(null)}
          onHostRoom={handleHostRoom}
          onJoinRoom={handleJoinRoom}
          onStartSolo={handleStartSolo}
        />
      )}

      {/* Active Gameplay HUD */}
      {shellState !== 'title' && (
        <GameHud
          hud={hud}
          role={role}
          roomId={roomId}
          inviteUrl={inviteUrl}
          peers={peers}
          muted={muted}
          feedEvents={feedEvents}
          onToggleMute={handleToggleMute}
          onPause={() => applyShellTransition('paused')}
          onRestart={handleRestartMatch}
          onTriggerShockwave={() => engineRef.current?.triggerManualShockwaveFromHud()}
        />
      )}

      {/* Pause & Match Summary Modal */}
      {(shellState === 'paused' || shellState === 'gameover') && (
        <StatusModal
          mode={shellState}
          role={role}
          roomId={roomId}
          roomName={roomName}
          inviteUrl={inviteUrl}
          peers={peers}
          botCount={botCount}
          summary={matchSummary}
          onChangeBotCount={handleChangeBotCount}
          onResume={() => applyShellTransition('playing')}
          onRestart={handleRestartMatch}
          onReturnToTitle={handleReturnToTitle}
        />
      )}
    </div>
  );
}
