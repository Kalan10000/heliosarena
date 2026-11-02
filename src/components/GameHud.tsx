import React, { useState } from 'react';
import {
  ConnectedPeerInfo,
  FeedEventItem,
  HudSnapshot,
  NetworkRole,
} from '../game/types';

interface GameHudProps {
  hud: HudSnapshot;
  role: NetworkRole;
  roomId: string | null;
  inviteUrl: string;
  peers: ConnectedPeerInfo[];
  muted: boolean;
  feedEvents: FeedEventItem[];
  onToggleMute: () => void;
  onPause: () => void;
  onRestart: () => void;
  onTriggerShockwave: () => void;
}

function formatTimer(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Code-authored inline <svg> Shield Vitality Socket with 3 readable states:
 * 'full' | 'cracked' | 'empty'
 */
const StabilityPipSvg: React.FC<{ state: 'full' | 'cracked' | 'empty' }> = ({
  state,
}) => {
  return (
    <svg width="26" height="28" viewBox="0 0 24 26" aria-hidden="true">
      {/* Dark outer silhouette */}
      <path
        d="M12 1.5L3 5.5V12.5C3 18.4 6.8 23.1 12 24.8C17.2 23.1 21 18.4 21 12.5V5.5L12 1.5Z"
        fill="#0b1120"
        stroke={state === 'empty' ? '#475569' : '#d4a359'}
        strokeWidth="1.8"
      />
      {state === 'full' && (
        <>
          <path
            d="M12 3.6L5 6.9V12.4C5 17.1 8 21 12 22.5C16 21 19 17.1 19 12.4V6.9L12 3.6Z"
            fill="#f59e0b"
          />
          <path
            d="M12 3.6L5 6.9V11.2L12 7.8L19 11.2V6.9L12 3.6Z"
            fill="#fef08a"
            opacity="0.7"
          />
        </>
      )}
      {state === 'cracked' && (
        <>
          <path
            d="M12 3.6L5 6.9V12.4C5 17.1 8 21 12 22.5C16 21 19 17.1 19 12.4V6.9L12 3.6Z"
            fill="#b45309"
          />
          <path
            d="M13.5 4.5L10 11.5L14 14L10.5 21.5"
            stroke="#0b1120"
            strokeWidth="2"
            fill="none"
          />
        </>
      )}
    </svg>
  );
};

export const GameHud: React.FC<GameHudProps> = ({
  hud,
  role,
  roomId,
  inviteUrl,
  peers,
  muted,
  feedEvents,
  onToggleMute,
  onPause,
  onRestart,
  onTriggerShockwave,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyInvite = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    if (!inviteUrl) return;
    navigator.clipboard?.writeText(inviteUrl).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  return (
    <div
      aria-label="Gameplay Heads-Up Display"
      className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-between p-4 sm:p-5"
    >
      {/* Top Perimeter Row: 3 Compact Corner/Edge Clusters (>= 85% central playfield clear) */}
      <div className="flex items-start justify-between gap-4">
        {/* Cluster 1 (Top-Left): Shield Stability Pips, Score/KO Hero Numerals & Kinetic Meters */}
        <div
          className="rounded-xl px-4 py-3 border border-[#d4a359]/40 shadow-lg flex flex-col gap-2.5"
          style={{ backgroundColor: 'rgba(12, 18, 32, 0.88)' }}
        >
          <div className="flex items-center gap-5">
            <div>
              <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4]">
                SCORE
              </div>
              <div className="hud-numeral text-3xl font-extrabold leading-none text-[#fef08a]">
                {Math.round(hud.score)}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4]">
                RING-OUTS
              </div>
              <div className="hud-numeral text-3xl font-extrabold leading-none text-[#f8f5ee]">
                {Math.round(hud.knockouts)}
              </div>
            </div>

            <div className="pl-1">
              <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4] mb-1">
                SHIELD
              </div>
              <div
                className="flex items-center gap-1"
                aria-label={`Shield stability ${hud.stability} of ${hud.maxStability}`}
              >
                {[0, 1, 2].map((idx) => {
                  const state =
                    hud.stability > idx
                      ? hud.stability === 1 && idx === 0
                        ? 'cracked'
                        : 'full'
                      : 'empty';
                  return <StabilityPipSvg key={idx} state={state} />;
                })}
              </div>
            </div>
          </div>

          {/* Ability Cooldown Bars (Single-line aligned) */}
          <div className="flex items-end gap-3.5 pt-0.5">
            <div className="flex-1 min-w-[104px]">
              <div className="flex items-center justify-between gap-2 text-[10px] font-semibold text-[#d8cbb6] mb-1 whitespace-nowrap">
                <span>DASH</span>
                <span className="font-mono-num">[SHIFT]</span>
              </div>
              <div className="h-1.5 w-full rounded-sm bg-[#1e293b] overflow-hidden">
                <div
                  className="h-full bg-[#38bdf8] transition-transform duration-75 origin-left"
                  style={{ transform: `scaleX(${hud.dashReadyRatio})` }}
                />
              </div>
            </div>

            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.currentTarget.blur();
                onTriggerShockwave();
              }}
              aria-label="Trigger Shockwave Pulse"
              className="pointer-events-auto flex-1 min-w-[132px] text-left cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2 text-[10px] font-semibold text-[#fef08a] mb-1 whitespace-nowrap">
                <span>SHOCKWAVE</span>
                <span className="font-mono-num">[E]</span>
              </div>
              <div className="h-1.5 w-full rounded-sm bg-[#1e293b] overflow-hidden">
                <div
                  className="h-full bg-[#f59e0b] transition-transform duration-75 origin-left"
                  style={{ transform: `scaleX(${hud.shockwaveReadyRatio})` }}
                />
              </div>
            </button>
          </div>
        </div>

        {/* Cluster 2 (Top-Center): Match Clock + Live WebRTC Room Code Invite */}
        <div
          className="rounded-xl px-4 py-2.5 border border-[#d4a359]/40 shadow-lg flex items-center gap-4"
          style={{ backgroundColor: 'rgba(12, 18, 32, 0.88)' }}
        >
          <div className="text-center">
            <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4]">
              FIRST TO 12
            </div>
            <div className="hud-numeral text-2xl sm:text-3xl font-extrabold leading-tight text-[#fdfaf3]">
              {formatTimer(hud.matchTimeRemaining)}
            </div>
          </div>

          {role !== 'offline' && roomId && (
            <div className="border-l border-white/15 pl-4 flex items-center gap-3">
              <div>
                <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4]">
                  {role === 'host' ? 'HOSTING ROOM' : 'JOINED ROOM'}
                </div>
                <div className="text-xs font-mono-num font-bold text-[#fef08a]">
                  {roomId} · {1 + peers.length} P2P
                </div>
              </div>
              <button
                type="button"
                tabIndex={-1}
                onClick={handleCopyInvite}
                className="pointer-events-auto px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#0b1120] bg-[#d4a359] hover:bg-[#e7b86a] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedCode ? 'Copied Link' : 'Copy Invite'}
              </button>
            </div>
          )}
        </div>

        {/* Cluster 3 (Top-Right): Compact Standings + Square SVG Utility Icon Buttons */}
        <div className="flex items-start gap-2.5">
          <div
            className="hidden md:flex flex-col gap-1 rounded-xl px-3.5 py-2.5 border border-[#d4a359]/35 shadow-lg min-w-[164px]"
            style={{ backgroundColor: 'rgba(12, 18, 32, 0.86)' }}
          >
            <div className="text-[10px] font-bold tracking-wider uppercase text-[#cbbda4]">
              STANDINGS
            </div>
            {hud.leaderboard.slice(0, 4).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span
                  className={`truncate max-w-[110px] ${
                    entry.isLocal ? 'font-bold text-[#fef08a]' : 'text-[#e2e8f0]'
                  }`}
                >
                  {entry.name}
                </span>
                <span className="font-mono-num font-bold text-[#f8fafc]">
                  {Math.round(entry.score)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-1.5 pointer-events-auto">
            <button
              type="button"
              tabIndex={-1}
              aria-label={muted ? 'Unmute Audio [M]' : 'Mute Audio [M]'}
              onClick={(e) => {
                e.currentTarget.blur();
                onToggleMute();
              }}
              className="w-10 h-10 rounded-lg border border-[#d4a359]/40 flex items-center justify-center text-[#f8f5ee] hover:border-[#fbbf24] transition-colors cursor-pointer"
              style={{ backgroundColor: 'rgba(12, 18, 32, 0.9)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                {muted ? (
                  <path d="M22 9l-6 6M16 9l6 6" stroke="#f87171" />
                ) : (
                  <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
                )}
              </svg>
            </button>

            {role !== 'client' && (
              <button
                type="button"
                tabIndex={-1}
                aria-label="Restart Match [R]"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onRestart();
                }}
                className="w-10 h-10 rounded-lg border border-[#d4a359]/40 flex items-center justify-center text-[#f8f5ee] hover:border-[#fbbf24] transition-colors cursor-pointer"
                style={{ backgroundColor: 'rgba(12, 18, 32, 0.9)' }}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            )}

            <button
              type="button"
              tabIndex={-1}
              aria-label="Pause and Room Settings [P]"
              onClick={(e) => {
                e.currentTarget.blur();
                onPause();
              }}
              className="w-10 h-10 rounded-lg border border-[#d4a359]/40 flex items-center justify-center text-[#f8f5ee] hover:border-[#fbbf24] transition-colors cursor-pointer"
              style={{ backgroundColor: 'rgba(12, 18, 32, 0.9)' }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom-Left Event Feed (Transient KO / Solar Core Goal notifications) */}
      <div className="flex flex-col gap-1.5 items-start max-w-sm">
        {feedEvents.map((ev) => (
          <div
            key={ev.id}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#fdfaf3] border border-white/15 shadow"
            style={{ backgroundColor: 'rgba(12, 18, 32, 0.88)' }}
          >
            {ev.message}
          </div>
        ))}
      </div>
    </div>
  );
};
