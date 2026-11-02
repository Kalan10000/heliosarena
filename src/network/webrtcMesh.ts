import mqtt, { MqttClient } from 'mqtt';
import {
  ConnectedPeerInfo,
  FastDataPacket,
  NetworkRole,
  PublicRoomListing,
  ReliableDataPacket,
} from '../game/types';
import { PLAYER_PALETTE } from '../game/rules';

const TOPIC_PREFIX = 'helios-arena-v2';
const LOBBY_TOPIC = `${TOPIC_PREFIX}/lobby/rooms`;

const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

interface SignalEnvelope {
  msgId: string;
  kind:
    | 'lobby-announce'
    | 'lobby-close'
    | 'lobby-query'
    | 'join-request'
    | 'sdp-offer'
    | 'sdp-answer'
    | 'ice-candidate';
  roomId: string;
  fromPeerId: string;
  targetPeerId?: string;
  payload: unknown;
}

interface JoinRequestPayload {
  name: string;
  colorHex: string;
}

interface SdpPayload {
  sdp: RTCSessionDescriptionInit;
  name: string;
  colorHex: string;
  roomName?: string;
}

interface ManagedPeer {
  peerId: string;
  name: string;
  colorHex: string;
  pc: RTCPeerConnection;
  fastChannel: RTCDataChannel | null;
  reliableChannel: RTCDataChannel | null;
  remoteDescSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  rttMs: number;
}

export interface WebRtcCallbacks {
  onRoomsUpdated: (rooms: PublicRoomListing[]) => void;
  onPeersUpdated: (peers: ConnectedPeerInfo[]) => void;
  onFastPacket: (fromPeerId: string, packet: FastDataPacket) => void;
  onReliablePacket: (fromPeerId: string, packet: ReliableDataPacket) => void;
  onPeerDisconnected: (peerId: string, name: string) => void;
  onPeerConnected: (peerId: string, name: string, colorHex: string) => void;
  onSignalingStatus: (connected: boolean, label: string) => void;
  onJoinConnectedToHost: (roomId: string, roomName: string, hostId: string) => void;
  onJoinError: (message: string) => void;
}

function randomId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export class HeliosWebRtcNetwork {
  public readonly localPeerId: string;
  private callbacks: WebRtcCallbacks;
  private role: NetworkRole = 'offline';
  private activeRoomId: string | null = null;
  private activeRoomName = 'Sky Citadel';
  private localName = 'Striker';
  private localColor = PLAYER_PALETTE[0];
  private botCount = 2;

  private mqttClient: MqttClient | null = null;
  private brokerIndex = 0;
  private localBus: BroadcastChannel | null = null;
  private seenMsgIds = new Set<string>();

  private discoveredRooms = new Map<string, PublicRoomListing>();
  private peers = new Map<string, ManagedPeer>();
  private earlyIceBuffer = new Map<string, RTCIceCandidateInit[]>();

  private announceTimer: number | null = null;
  private pruneTimer: number | null = null;
  private pingTimer: number | null = null;
  private joinTimeoutTimer: number | null = null;
  private destroyed = false;

  constructor(callbacks: WebRtcCallbacks) {
    this.localPeerId = randomId('peer');
    this.callbacks = callbacks;
    this.initLocalBroadcastBus();
    this.initMqttDiscovery();

    this.pruneTimer = window.setInterval(() => {
      this.pruneStaleRooms();
    }, 3000);

    this.pingTimer = window.setInterval(() => {
      this.sendPingToPeers();
    }, 2000);

    window.addEventListener('beforeunload', this.handleWindowUnload);
  }

  private handleWindowUnload = (): void => {
    if (this.role === 'host' && this.activeRoomId) {
      this.publishSignal(LOBBY_TOPIC, {
        msgId: randomId('m'),
        kind: 'lobby-close',
        roomId: this.activeRoomId,
        fromPeerId: this.localPeerId,
        payload: {},
      });
    }
  };

  private initLocalBroadcastBus(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.localBus = new BroadcastChannel(`${TOPIC_PREFIX}-bus`);
      this.localBus.onmessage = (ev: MessageEvent<SignalEnvelope>) => {
        if (ev.data && typeof ev.data === 'object') {
          this.handleSignalEnvelope(ev.data, 'local-tab');
        }
      };
      // Query any already-open host tabs immediately
      this.localBus.postMessage({
        msgId: randomId('q'),
        kind: 'lobby-query',
        roomId: '*',
        fromPeerId: this.localPeerId,
        payload: {},
      } satisfies SignalEnvelope);
    } catch {
      this.localBus = null;
    }
  }

  private initMqttDiscovery(): void {
    if (this.destroyed) return;
    const brokerUrl = MQTT_BROKERS[this.brokerIndex % MQTT_BROKERS.length];
    try {
      const client = mqtt.connect(brokerUrl, {
        clientId: `helios_${this.localPeerId}_${Math.floor(Math.random() * 9999)}`,
        clean: true,
        connectTimeout: 6000,
        reconnectPeriod: 4000,
      });
      this.mqttClient = client;

      client.on('connect', () => {
        if (this.destroyed) return;
        this.callbacks.onSignalingStatus(true, 'Global Relay Online');
        client.subscribe(LOBBY_TOPIC);
        client.subscribe(`${TOPIC_PREFIX}/signal/${this.localPeerId}`);
        if (this.role === 'host' && this.activeRoomId) {
          client.subscribe(`${TOPIC_PREFIX}/room/${this.activeRoomId}/join`);
          this.broadcastRoomPresence();
        }
        // Ask active internet hosts to announce immediately so rooms appear in <300ms
        this.publishMqttOnly(LOBBY_TOPIC, {
          msgId: randomId('q'),
          kind: 'lobby-query',
          roomId: '*',
          fromPeerId: this.localPeerId,
          payload: {},
        });
      });

      client.on('message', (_topic, buffer) => {
        if (this.destroyed) return;
        try {
          const parsed = JSON.parse(buffer.toString()) as SignalEnvelope;
          this.handleSignalEnvelope(parsed, 'global-wss');
        } catch {
          // Ignore malformed third-party messages
        }
      });

      client.on('error', () => {
        if (this.destroyed) return;
        this.callbacks.onSignalingStatus(false, 'Local Relay Ready · Retrying Global');
        if (this.brokerIndex < MQTT_BROKERS.length - 1) {
          this.brokerIndex += 1;
          client.end(true);
          this.initMqttDiscovery();
        }
      });
    } catch {
      this.callbacks.onSignalingStatus(false, 'Local P2P Ready');
    }
  }

  private publishMqttOnly(topic: string, env: SignalEnvelope): void {
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(topic, JSON.stringify(env), { qos: 0 });
    }
  }

  private publishSignal(topic: string, env: SignalEnvelope): void {
    this.seenMsgIds.add(env.msgId);
    if (this.seenMsgIds.size > 600) {
      const first = this.seenMsgIds.values().next().value;
      if (first) this.seenMsgIds.delete(first);
    }

    const rawJson = JSON.stringify(env);
    if (this.localBus) {
      try {
        this.localBus.postMessage(JSON.parse(rawJson));
      } catch {
        // Ignore closed channel
      }
    }
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(topic, rawJson, { qos: 0 });
    }
  }

  private handleSignalEnvelope(
    env: SignalEnvelope,
    transport: 'global-wss' | 'local-tab'
  ): void {
    if (!env || env.fromPeerId === this.localPeerId) return;
    if (this.seenMsgIds.has(env.msgId)) return;
    this.seenMsgIds.add(env.msgId);

    if (env.targetPeerId && env.targetPeerId !== this.localPeerId) {
      return;
    }

    switch (env.kind) {
      case 'lobby-query': {
        if (this.role === 'host' && this.activeRoomId) {
          this.broadcastRoomPresence();
        }
        break;
      }
      case 'lobby-announce': {
        const listing = env.payload as PublicRoomListing;
        if (!listing || !listing.roomId) return;
        this.discoveredRooms.set(listing.roomId, {
          ...listing,
          updatedAt: Date.now(),
          transport,
        });
        this.emitRooms();
        break;
      }
      case 'lobby-close': {
        if (this.discoveredRooms.delete(env.roomId)) {
          this.emitRooms();
        }
        break;
      }
      case 'join-request': {
        if (this.role !== 'host' || env.roomId !== this.activeRoomId) return;
        const req = env.payload as JoinRequestPayload;
        void this.handleHostIncomingJoinRequest(
          env.fromPeerId,
          req?.name || 'Guest',
          req?.colorHex || PLAYER_PALETTE[1]
        );
        break;
      }
      case 'sdp-offer': {
        if (this.role !== 'client' || env.roomId !== this.activeRoomId) return;
        const data = env.payload as SdpPayload;
        void this.handleClientReceiveOffer(env.fromPeerId, data);
        break;
      }
      case 'sdp-answer': {
        if (this.role !== 'host' || env.roomId !== this.activeRoomId) return;
        const data = env.payload as SdpPayload;
        void this.handleHostReceiveAnswer(env.fromPeerId, data);
        break;
      }
      case 'ice-candidate': {
        const candidate = env.payload as RTCIceCandidateInit;
        if (!candidate) return;
        const managed = this.peers.get(env.fromPeerId);
        if (!managed) {
          const list = this.earlyIceBuffer.get(env.fromPeerId) ?? [];
          list.push(candidate);
          this.earlyIceBuffer.set(env.fromPeerId, list);
          return;
        }
        if (managed.remoteDescSet) {
          managed.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        } else {
          managed.pendingIce.push(candidate);
        }
        break;
      }
    }
  }

  private pruneStaleRooms(): void {
    const now = Date.now();
    let changed = false;
    for (const [roomId, info] of this.discoveredRooms.entries()) {
      if (now - info.updatedAt > 9500) {
        this.discoveredRooms.delete(roomId);
        changed = true;
      }
    }
    if (changed) this.emitRooms();
  }

  private emitRooms(): void {
    const sorted = Array.from(this.discoveredRooms.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
    this.callbacks.onRoomsUpdated(sorted);
  }

  private emitPeers(): void {
    const list: ConnectedPeerInfo[] = [];
    for (const p of this.peers.values()) {
      list.push({
        peerId: p.peerId,
        name: p.name,
        colorHex: p.colorHex,
        connectionState: p.pc.connectionState,
        dataChannelOpen:
          p.fastChannel?.readyState === 'open' ||
          p.reliableChannel?.readyState === 'open',
        rttMs: Math.round(p.rttMs),
      });
    }
    this.callbacks.onPeersUpdated(list);
  }

  public getRole(): NetworkRole {
    return this.role;
  }

  public getRoomId(): string | null {
    return this.activeRoomId;
  }

  public getRoomName(): string {
    return this.activeRoomName;
  }

  public setBotCount(count: number): void {
    this.botCount = count;
    if (this.role === 'host') {
      this.broadcastRoomPresence();
      this.broadcastRosterToClients();
    }
  }

  public buildInviteUrl(): string {
    if (typeof window === 'undefined' || !this.activeRoomId) return '';
    const url = new URL(window.location.href);
    url.searchParams.delete('autostart');
    url.searchParams.set('room', this.activeRoomId);
    return url.toString();
  }

  public hostRoom(params: {
    roomId: string;
    roomName: string;
    hostName: string;
    colorHex: string;
    botCount: number;
  }): void {
    this.leaveRoom();
    this.role = 'host';
    this.activeRoomId = params.roomId;
    this.activeRoomName = params.roomName;
    this.localName = params.hostName;
    this.localColor = params.colorHex;
    this.botCount = params.botCount;

    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.subscribe(`${TOPIC_PREFIX}/room/${this.activeRoomId}/join`);
    }

    this.broadcastRoomPresence();
    this.announceTimer = window.setInterval(() => {
      this.broadcastRoomPresence();
    }, 2500);
  }

  public startSolo(params: {
    playerName: string;
    colorHex: string;
    botCount: number;
  }): void {
    this.leaveRoom();
    this.role = 'offline';
    this.activeRoomId = null;
    this.localName = params.playerName;
    this.localColor = params.colorHex;
    this.botCount = params.botCount;
  }

  public joinRoom(params: {
    roomId: string;
    playerName: string;
    colorHex: string;
  }): void {
    this.leaveRoom();
    this.role = 'client';
    this.activeRoomId = params.roomId;
    this.localName = params.playerName;
    this.localColor = params.colorHex;

    // Pick a distinct color from palette based on peer ID hash if default
    const joinTopic = `${TOPIC_PREFIX}/room/${params.roomId}/join`;
    const sendReq = () => {
      if (this.role !== 'client' || this.peers.size > 0) return;
      this.publishSignal(joinTopic, {
        msgId: randomId('jr'),
        kind: 'join-request',
        roomId: params.roomId,
        fromPeerId: this.localPeerId,
        payload: {
          name: this.localName,
          colorHex: this.localColor,
        } satisfies JoinRequestPayload,
      });
    };

    sendReq();
    // Retry once after 1.2s in case MQTT subscription was still handshaking
    window.setTimeout(sendReq, 1200);

    this.joinTimeoutTimer = window.setTimeout(() => {
      const hasOpenPeer = Array.from(this.peers.values()).some(
        (p) =>
          p.reliableChannel?.readyState === 'open' ||
          p.pc.connectionState === 'connected'
      );
      if (this.role === 'client' && !hasOpenPeer) {
        this.callbacks.onJoinError(
          `Could not reach host for room "${params.roomId}". Verify the host tab is open and try again.`
        );
        this.leaveRoom();
      }
    }, 9000);
  }

  private broadcastRoomPresence(): void {
    if (this.role !== 'host' || !this.activeRoomId) return;
    const listing: PublicRoomListing = {
      roomId: this.activeRoomId,
      roomName: this.activeRoomName,
      hostId: this.localPeerId,
      hostName: this.localName,
      playerCount: 1 + this.peers.size,
      maxPlayers: 6,
      botCount: this.botCount,
      arenaName: 'Sunforge Citadel',
      status: 'open',
      updatedAt: Date.now(),
      transport: 'global-wss',
    };
    this.publishSignal(LOBBY_TOPIC, {
      msgId: randomId('hb'),
      kind: 'lobby-announce',
      roomId: this.activeRoomId,
      fromPeerId: this.localPeerId,
      payload: listing,
    });
  }

  private createPeerConnection(
    remotePeerId: string,
    remoteName: string,
    remoteColor: string
  ): ManagedPeer {
    const existing = this.peers.get(remotePeerId);
    if (existing) {
      existing.pc.close();
      this.peers.delete(remotePeerId);
    }

    const early = this.earlyIceBuffer.get(remotePeerId) ?? [];
    this.earlyIceBuffer.delete(remotePeerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const managed: ManagedPeer = {
      peerId: remotePeerId,
      name: remoteName,
      colorHex: remoteColor,
      pc,
      fastChannel: null,
      reliableChannel: null,
      remoteDescSet: false,
      pendingIce: [...early],
      rttMs: 12,
    };
    this.peers.set(remotePeerId, managed);

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.activeRoomId) {
        this.publishSignal(`${TOPIC_PREFIX}/signal/${remotePeerId}`, {
          msgId: randomId('ice'),
          kind: 'ice-candidate',
          roomId: this.activeRoomId,
          fromPeerId: this.localPeerId,
          targetPeerId: remotePeerId,
          payload: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      this.emitPeers();
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        if (this.peers.has(remotePeerId)) {
          this.peers.delete(remotePeerId);
          this.emitPeers();
          this.callbacks.onPeerDisconnected(remotePeerId, managed.name);
          if (this.role === 'host') {
            this.broadcastRoomPresence();
            this.broadcastRosterToClients();
          }
        }
      }
    };

    this.emitPeers();
    return managed;
  }

  private wireDataChannel(managed: ManagedPeer, channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (this.joinTimeoutTimer !== null) {
        window.clearTimeout(this.joinTimeoutTimer);
        this.joinTimeoutTimer = null;
      }
      this.emitPeers();
      if (channel.label === 'reliable') {
        this.callbacks.onPeerConnected(
          managed.peerId,
          managed.name,
          managed.colorHex
        );
        if (this.role === 'host') {
          this.broadcastRoomPresence();
          this.broadcastRosterToClients();
        } else if (this.role === 'client' && this.activeRoomId) {
          this.callbacks.onJoinConnectedToHost(
            this.activeRoomId,
            this.activeRoomName,
            managed.peerId
          );
        }
      }
    };

    channel.onclose = () => {
      this.emitPeers();
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const parsed = JSON.parse(ev.data);
        if (channel.label === 'fast') {
          this.callbacks.onFastPacket(managed.peerId, parsed as FastDataPacket);
        } else {
          const rel = parsed as ReliableDataPacket;
          if (rel.type === 'ping') {
            if (managed.reliableChannel?.readyState === 'open') {
              managed.reliableChannel.send(
                JSON.stringify({ type: 'pong', sentAt: rel.sentAt })
              );
            }
            return;
          }
          if (rel.type === 'pong') {
            managed.rttMs = Math.max(1, performance.now() - rel.sentAt);
            this.emitPeers();
            return;
          }
          this.callbacks.onReliablePacket(managed.peerId, rel);
        }
      } catch {
        // Ignore invalid packet
      }
    };
  }

  private waitBrieflyForHostIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }, 240);
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          window.clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private async handleHostIncomingJoinRequest(
    clientPeerId: string,
    clientName: string,
    requestedColor: string
  ): Promise<void> {
    if (!this.activeRoomId || this.peers.size >= 5) return;

    const existingNames = new Set<string>([
      this.localName.toLowerCase(),
      ...Array.from(this.peers.values()).map((p) => p.name.toLowerCase()),
    ]);
    const finalClientName = existingNames.has(clientName.toLowerCase())
      ? `${clientName} #${this.peers.size + 2}`
      : clientName;

    // Assign a distinct color if colliding with host/existing peer colors
    const usedColors = new Set<string>([
      this.localColor,
      ...Array.from(this.peers.values()).map((p) => p.colorHex),
    ]);
    const assignedColor = usedColors.has(requestedColor)
      ? PLAYER_PALETTE.find((c) => !usedColors.has(c)) ?? requestedColor
      : requestedColor;

    const managed = this.createPeerConnection(
      clientPeerId,
      finalClientName,
      assignedColor
    );

    const fast = managed.pc.createDataChannel('fast', {
      ordered: false,
      maxRetransmits: 0,
    });
    const reliable = managed.pc.createDataChannel('reliable', {
      ordered: true,
    });
    managed.fastChannel = fast;
    managed.reliableChannel = reliable;
    this.wireDataChannel(managed, fast);
    this.wireDataChannel(managed, reliable);

    const offer = await managed.pc.createOffer();
    await managed.pc.setLocalDescription(offer);
    await this.waitBrieflyForHostIce(managed.pc);

    this.publishSignal(`${TOPIC_PREFIX}/signal/${clientPeerId}`, {
      msgId: randomId('off'),
      kind: 'sdp-offer',
      roomId: this.activeRoomId,
      fromPeerId: this.localPeerId,
      targetPeerId: clientPeerId,
      payload: {
        sdp: managed.pc.localDescription ?? offer,
        name: this.localName,
        colorHex: assignedColor,
        roomName: this.activeRoomName,
      } satisfies SdpPayload,
    });
  }

  private async handleClientReceiveOffer(
    hostPeerId: string,
    data: SdpPayload
  ): Promise<void> {
    if (!this.activeRoomId) return;
    if (data.roomName) this.activeRoomName = data.roomName;

    const managed = this.createPeerConnection(
      hostPeerId,
      data.name || 'Host',
      PLAYER_PALETTE[0]
    );

    managed.pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'fast') {
        managed.fastChannel = ev.channel;
      } else if (ev.channel.label === 'reliable') {
        managed.reliableChannel = ev.channel;
      }
      this.wireDataChannel(managed, ev.channel);
    };

    await managed.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    managed.remoteDescSet = true;
    for (const cand of managed.pendingIce) {
      await managed.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    }
    managed.pendingIce = [];

    const answer = await managed.pc.createAnswer();
    await managed.pc.setLocalDescription(answer);
    await this.waitBrieflyForHostIce(managed.pc);

    this.publishSignal(`${TOPIC_PREFIX}/signal/${hostPeerId}`, {
      msgId: randomId('ans'),
      kind: 'sdp-answer',
      roomId: this.activeRoomId,
      fromPeerId: this.localPeerId,
      targetPeerId: hostPeerId,
      payload: {
        sdp: managed.pc.localDescription ?? answer,
        name: this.localName,
        colorHex: this.localColor,
      } satisfies SdpPayload,
    });
  }

  private async handleHostReceiveAnswer(
    clientPeerId: string,
    data: SdpPayload
  ): Promise<void> {
    const managed = this.peers.get(clientPeerId);
    if (!managed) return;
    await managed.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    managed.remoteDescSet = true;
    for (const cand of managed.pendingIce) {
      await managed.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    }
    managed.pendingIce = [];
  }

  private sendPingToPeers(): void {
    const now = performance.now();
    const msg = JSON.stringify({ type: 'ping', sentAt: now });
    for (const p of this.peers.values()) {
      if (p.reliableChannel?.readyState === 'open') {
        try {
          p.reliableChannel.send(msg);
        } catch {
          // Ignore transient buffer full
        }
      }
    }
  }

  public broadcastRosterToClients(): void {
    if (this.role !== 'host' || !this.activeRoomId) return;
    const packet: ReliableDataPacket = {
      type: 'room-roster',
      roomId: this.activeRoomId,
      roomName: this.activeRoomName,
      hostId: this.localPeerId,
      botCount: this.botCount,
      peers: [
        {
          id: this.localPeerId,
          name: this.localName,
          colorHex: this.localColor,
          rttMs: 0,
        },
        ...Array.from(this.peers.values()).map((p) => ({
          id: p.peerId,
          name: p.name,
          colorHex: p.colorHex,
          rttMs: Math.round(p.rttMs),
        })),
      ],
    };
    this.broadcastReliable(packet);
  }

  public broadcastFast(packet: FastDataPacket): void {
    const raw = JSON.stringify(packet);
    for (const p of this.peers.values()) {
      if (
        p.fastChannel?.readyState === 'open' &&
        p.fastChannel.bufferedAmount < 65536
      ) {
        try {
          p.fastChannel.send(raw);
        } catch {
          // Drop unreliable frame cleanly
        }
      }
    }
  }

  public broadcastReliable(packet: ReliableDataPacket): void {
    const raw = JSON.stringify(packet);
    for (const p of this.peers.values()) {
      if (p.reliableChannel?.readyState === 'open') {
        try {
          p.reliableChannel.send(raw);
        } catch {
          // Ignore closed channel
        }
      }
    }
  }

  public leaveRoom(): void {
    if (this.announceTimer !== null) {
      window.clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.joinTimeoutTimer !== null) {
      window.clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }

    if (this.role === 'host' && this.activeRoomId) {
      if (this.mqttClient && this.mqttClient.connected) {
        this.mqttClient.unsubscribe(
          `${TOPIC_PREFIX}/room/${this.activeRoomId}/join`
        );
      }
      this.publishSignal(LOBBY_TOPIC, {
        msgId: randomId('cl'),
        kind: 'lobby-close',
        roomId: this.activeRoomId,
        fromPeerId: this.localPeerId,
        payload: {},
      });
    }

    for (const p of this.peers.values()) {
      try {
        p.fastChannel?.close();
        p.reliableChannel?.close();
        p.pc.close();
      } catch {
        // Ignore close errors
      }
    }
    this.peers.clear();
    this.role = 'offline';
    this.activeRoomId = null;
    this.emitPeers();
  }

  public destroy(): void {
    this.destroyed = true;
    this.leaveRoom();
    window.removeEventListener('beforeunload', this.handleWindowUnload);
    if (this.pruneTimer !== null) window.clearInterval(this.pruneTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.localBus) {
      this.localBus.close();
      this.localBus = null;
    }
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
  }
}
