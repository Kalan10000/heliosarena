import React, { useState } from 'react';
import { PublicRoomListing } from '../game/types';
import {
  PLAYER_PALETTE,
  validateHostSetup,
  validateRoomJoinInput,
} from '../game/rules';

interface TitleOverlayProps {
  defaultCallsign: string;
  defaultRoomCode: string;
  signalingLabel: string;
  signalingConnected: boolean;
  rooms: PublicRoomListing[];
  joinError: string | null;
  joiningRoomId: string | null;
  onClearJoinError: () => void;
  onHostRoom: (params: {
    callsign: string;
    roomName: string;
    colorHex: string;
    botCount: number;
  }) => void;
  onJoinRoom: (params: {
    callsign: string;
    roomCode: string;
    colorHex: string;
  }) => void;
  onStartSolo: (params: {
    callsign: string;
    colorHex: string;
    botCount: number;
  }) => void;
}

const CALLSIGN_PRESETS = ['Nova', 'Helios', 'Valkyrie', 'Zephyr', 'Atlas'];

export const TitleOverlay: React.FC<TitleOverlayProps> = ({
  defaultCallsign,
  defaultRoomCode,
  signalingLabel,
  rooms,
  joinError,
  joiningRoomId,
  onClearJoinError,
  onHostRoom,
  onJoinRoom,
  onStartSolo,
}) => {
  const [callsign, setCallsign] = useState(defaultCallsign);
  const [roomName, setRoomName] = useState('Sunforge Clash');
  const [joinCode, setJoinCode] = useState(defaultRoomCode);
  const [selectedColor, setSelectedColor] = useState(PLAYER_PALETTE[0]);
  const [botCount, setBotCount] = useState<number>(2);
  const [formError, setFormError] = useState<string | null>(null);

  const handleHostSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onClearJoinError();
    const check = validateHostSetup(callsign, roomName);
    if (!check.valid) {
      setFormError(check.error ?? 'Check your callsign and room name.');
      return;
    }
    setFormError(null);
    onHostRoom({
      callsign: check.normalizedCallsign!,
      roomName: check.normalizedRoomName!,
      colorHex: selectedColor,
      botCount,
    });
  };

  const handleSoloClick = () => {
    onClearJoinError();
    const trimmed = callsign.trim();
    if (trimmed.length < 2) {
      setFormError('Enter a callsign of at least 2 characters.');
      return;
    }
    setFormError(null);
    onStartSolo({
      callsign: trimmed.slice(0, 16),
      colorHex: selectedColor,
      botCount: Math.max(1, botCount),
    });
  };

  const handleJoinByCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onClearJoinError();
    const check = validateRoomJoinInput(callsign, joinCode);
    if (!check.valid) {
      setFormError(check.error ?? 'Enter a valid room code.');
      return;
    }
    setFormError(null);
    onJoinRoom({
      callsign: check.normalizedCallsign!,
      roomCode: check.normalizedCode!,
      colorHex: selectedColor,
    });
  };

  const handleQuickJoinRoom = (roomId: string) => {
    onClearJoinError();
    const check = validateRoomJoinInput(callsign, roomId);
    if (!check.valid) {
      setFormError(check.error ?? 'Enter your callsign first.');
      return;
    }
    setFormError(null);
    onJoinRoom({
      callsign: check.normalizedCallsign!,
      roomCode: check.normalizedCode!,
      colorHex: selectedColor,
    });
  };

  const activeError = formError || joinError;

  return (
    <main
      aria-label="Helios Arena Title Screen"
      className="fixed inset-0 z-20 flex flex-col justify-between p-4 sm:p-8 lg:p-10 overflow-y-auto pointer-events-auto lg:pointer-events-none"
      style={{
        background:
          'linear-gradient(95deg, rgba(10, 16, 29, 0.84) 0%, rgba(10, 16, 29, 0.46) 46%, rgba(10, 16, 29, 0.72) 100%)',
      }}
    >
      {/* Main Split Stage: Left Crest & Host Controls over Negative Space | Right Live WebRTC Room Browser */}
      <div className="my-auto w-full max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-10 items-center">
        {/* Left Column: Bespoke SVG Sun-Crest Lockup + Striker Setup */}
        <section className="lg:col-span-6 flex flex-col gap-5 pointer-events-auto">
          <div className="flex flex-col gap-2">
            {/* Custom Inline SVG Emblem & Title Lockup */}
            <div className="flex items-center gap-3.5">
              <svg
                width="54"
                height="54"
                viewBox="0 0 64 64"
                aria-hidden="true"
                className="shrink-0"
              >
                <polygon
                  points="32,3 39,16 54,12 48,26 61,32 48,38 54,52 39,48 32,61 25,48 10,52 16,38 3,32 16,26 10,12 25,16"
                  fill="#d4a359"
                  stroke="#0b1120"
                  strokeWidth="2.5"
                />
                <circle
                  cx="32"
                  cy="32"
                  r="15"
                  fill="#0f172a"
                  stroke="#fef08a"
                  strokeWidth="2.2"
                />
                <circle cx="32" cy="32" r="7.5" fill="#f59e0b" />
                <circle cx="29.5" cy="29.5" r="2.5" fill="#fef9c3" />
              </svg>
              <div>
                <h1
                  className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-[#fdfaf3]"
                  style={{ textWrap: 'balance' }}
                >
                  HELIOS ARENA
                </h1>
                <p className="text-sm text-[#e2d6c1] mt-0.5">
                  Skyward 3D Physics Knockout · P2P WebRTC Multiplayer
                </p>
              </div>
            </div>
          </div>

          {/* Host & Striker Rig Configuration Panel */}
          <form
            onSubmit={handleHostSubmit}
            className="rounded-xl p-5 sm:p-6 border border-[#d4a359]/35 shadow-2xl flex flex-col gap-4 max-w-xl"
            style={{ backgroundColor: 'rgba(13, 20, 35, 0.92)' }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label
                  htmlFor="callsign-input"
                  className="block text-xs font-semibold text-[#d9ccb6] mb-1.5"
                >
                  Player Callsign
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="callsign-input"
                    type="text"
                    maxLength={16}
                    value={callsign}
                    onChange={(e) => {
                      setCallsign(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="e.g. Nova"
                    className="w-full rounded-lg px-3 py-2 text-sm text-[#fdfaf3] bg-[#162238] border border-[#d4a359]/30 focus:outline-none focus:border-[#f59e0b]"
                  />
                  <button
                    type="button"
                    aria-label="Randomize callsign"
                    onClick={() => {
                      const next =
                        CALLSIGN_PRESETS[
                          (CALLSIGN_PRESETS.indexOf(callsign) + 1) %
                            CALLSIGN_PRESETS.length
                        ];
                      setCallsign(next);
                    }}
                    className="px-2.5 py-2 rounded-lg text-xs font-medium text-[#e7dcc8] bg-[#1c2b45] hover:bg-[#253757] border border-[#d4a359]/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Cycle
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="room-title-input"
                  className="block text-xs font-semibold text-[#d9ccb6] mb-1.5"
                >
                  Hosted Room Name
                </label>
                <input
                  id="room-title-input"
                  type="text"
                  maxLength={28}
                  value={roomName}
                  onChange={(e) => {
                    setRoomName(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  placeholder="Sunforge Clash"
                  className="w-full rounded-lg px-3 py-2 text-sm text-[#fdfaf3] bg-[#162238] border border-[#d4a359]/30 focus:outline-none focus:border-[#f59e0b]"
                />
              </div>
            </div>

            {/* Chassis Trim Swatch & Arena Bots */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
              <div>
                <span className="block text-xs font-semibold text-[#d9ccb6] mb-1.5">
                  Striker Hull Enamel
                </span>
                <div className="flex items-center gap-2" role="radiogroup" aria-label="Striker Hull Color">
                  {PLAYER_PALETTE.map((hex, i) => {
                    const selected = selectedColor === hex;
                    const colorNames = ['Cobalt', 'Vermilion', 'Emerald', 'Amber', 'Amethyst', 'Teal'];
                    return (
                      <button
                        key={hex}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={`Select ${colorNames[i]} hull`}
                        onClick={() => setSelectedColor(hex)}
                        className={`w-7 h-7 rounded-md transition-transform cursor-pointer ${
                          selected
                            ? 'ring-2 ring-[#fef08a] scale-110'
                            : 'opacity-80 hover:opacity-100'
                        }`}
                        style={{ backgroundColor: hex }}
                      />
                    );
                  })}
                </div>
              </div>

              <div>
                <span className="block text-xs font-semibold text-[#d9ccb6] mb-1.5">
                  Arena Bots (Host)
                </span>
                <div className="flex items-center gap-1 p-1 rounded-lg bg-[#162238] border border-[#d4a359]/25">
                  {[0, 1, 2, 3].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setBotCount(n)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        botCount === n
                          ? 'bg-[#d4a359] text-[#0b1120]'
                          : 'text-[#cbd5e1] hover:text-white'
                      }`}
                    >
                      {n === 0 ? 'None' : `${n}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {activeError && (
              <p
                role="alert"
                className="text-xs font-medium text-[#fca5a5] bg-[#451a1a] border border-[#ef4444]/40 rounded-lg px-3 py-2"
              >
                {activeError}
              </p>
            )}

            {/* Primary & Secondary Start Actions (<= 3 actions total) */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                data-start="true"
                className="flex-1 min-w-[180px] py-3 px-5 rounded-lg font-display font-bold text-base text-[#0b1120] bg-[#f59e0b] hover:bg-[#fbbf24] transition-colors shadow-lg cursor-pointer whitespace-nowrap shrink-0"
              >
                Host Public Room
              </button>
              <button
                type="button"
                onClick={handleSoloClick}
                className="py-3 px-4 rounded-lg font-semibold text-sm text-[#f3ead8] bg-[#1b2a44] hover:bg-[#243759] border border-[#d4a359]/35 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Solo Practice
              </button>
            </div>
          </form>
        </section>

        {/* Right Column: Live WebRTC Room Discovery & Direct Code Join */}
        <section
          aria-label="Live Multiplayer Rooms"
          className="lg:col-span-6 pointer-events-auto rounded-xl p-5 sm:p-6 border border-[#d4a359]/35 shadow-2xl flex flex-col gap-4"
          style={{ backgroundColor: 'rgba(13, 20, 35, 0.92)' }}
        >
          <div className="flex items-baseline justify-between gap-4 border-b border-white/10 pb-3">
            <div>
              <h2 className="font-display text-xl font-bold text-[#fdfaf3]">
                Open WebRTC Rooms
              </h2>
              <p className="text-xs text-[#cbbda4] mt-0.5">
                {signalingLabel} · Direct P2P DataChannel Sync
              </p>
            </div>
            <span className="text-xs font-mono-num text-[#e5d5b7] whitespace-nowrap shrink-0">
              {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} visible
            </span>
          </div>

          {/* Discovered Rooms List */}
          <div className="min-h-[168px] max-h-[240px] overflow-y-auto flex flex-col gap-2.5 pr-1">
            {rooms.length === 0 ? (
              <div className="my-auto py-8 px-4 text-center rounded-lg border border-dashed border-white/15 bg-[#131e33]">
                <p className="text-sm font-medium text-[#e6dac6]">
                  No public rooms broadcasting right now
                </p>
                <p className="text-xs text-[#9fb0c9] mt-1 max-w-sm mx-auto">
                  Click Host Public Room to broadcast your lobby globally, or enter a friend&apos;s room code below.
                </p>
              </div>
            ) : (
              rooms.map((room) => {
                const isJoiningThis = joiningRoomId === room.roomId;
                return (
                  <div
                    key={room.roomId}
                    className="flex items-center justify-between gap-4 p-3.5 rounded-lg bg-[#16233b] border border-[#d4a359]/25 hover:border-[#d4a359]/55 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="font-display font-bold text-base text-[#fdfaf3] truncate">
                        {room.roomName}
                      </div>
                      <div className="text-xs text-[#c7b9a1] mt-0.5 truncate">
                        <span>Host: {room.hostName}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono-num">
                          {room.playerCount}/{room.maxPlayers} Players
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono-num">Code {room.roomId}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={joiningRoomId !== null}
                      onClick={() => handleQuickJoinRoom(room.roomId)}
                      className="px-4 py-2 rounded-lg text-xs font-bold text-[#0b1120] bg-[#f59e0b] hover:bg-[#fbbf24] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      {isJoiningThis ? 'Connecting...' : `Join ${room.roomName}`}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Direct Room Code Join Form */}
          <form
            onSubmit={handleJoinByCodeSubmit}
            className="pt-3 border-t border-white/10 flex flex-col sm:flex-row sm:items-end gap-3"
          >
            <div className="flex-1">
              <label
                htmlFor="join-code-input"
                className="block text-xs font-semibold text-[#d9ccb6] mb-1.5"
              >
                Join by Friend&apos;s Room Code
              </label>
              <input
                id="join-code-input"
                type="text"
                maxLength={8}
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value.toUpperCase());
                  if (formError) setFormError(null);
                }}
                placeholder="Enter 5-char code (e.g. K7M4P)"
                className="w-full rounded-lg px-3 py-2 text-sm font-mono-num uppercase tracking-wider text-[#fdfaf3] bg-[#162238] border border-[#d4a359]/30 focus:outline-none focus:border-[#f59e0b]"
              />
            </div>
            <button
              type="submit"
              disabled={joiningRoomId !== null}
              className="py-2 px-4 h-[38px] rounded-lg font-semibold text-sm text-[#fdfaf3] bg-[#2563eb] hover:bg-[#3b82f6] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {joiningRoomId ? 'Connecting...' : 'Join by Code'}
            </button>
          </form>
        </section>
      </div>

      {/* Flat Borderless Single-Line Control Hint in Bottom Safe Margin */}
      <div className="w-full text-center text-xs sm:text-sm text-[#e8decb] tracking-wide pt-2">
        WASD Move · Space Jump · Shift Kinetic Dash · Click or E Shockwave Pulse · Esc Pause &amp; Invite
      </div>
    </main>
  );
};
