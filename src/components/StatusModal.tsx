import React, { useState } from 'react';
import {
  ConnectedPeerInfo,
  FrozenMatchSummary,
  NetworkRole,
} from '../game/types';

interface StatusModalProps {
  mode: 'paused' | 'gameover';
  role: NetworkRole;
  roomId: string | null;
  roomName: string;
  inviteUrl: string;
  peers: ConnectedPeerInfo[];
  botCount: number;
  summary: FrozenMatchSummary | null;
  onChangeBotCount: (count: number) => void;
  onResume: () => void;
  onRestart: () => void;
  onReturnToTitle: () => void;
}

export const StatusModal: React.FC<StatusModalProps> = ({
  mode,
  role,
  roomId,
  roomName,
  inviteUrl,
  peers,
  botCount,
  summary,
  onChangeBotCount,
  onResume,
  onRestart,
  onReturnToTitle,
}) => {
  const [copied, setCopied] = useState(false);

  const copyInvite = () => {
    if (!inviteUrl) return;
    navigator.clipboard?.writeText(inviteUrl).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  if (mode === 'paused') {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Match Paused and Room Lobby"
        className="fixed inset-0 z-30 flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(8, 13, 24, 0.72)' }}
      >
        <div
          className="w-full max-w-lg rounded-xl p-6 border border-[#d4a359]/45 shadow-2xl flex flex-col gap-5"
          style={{ backgroundColor: 'rgba(14, 22, 38, 0.96)' }}
        >
          <div>
            <h2 className="font-display text-2xl font-extrabold text-[#fdfaf3]">
              {role === 'offline' ? 'Solo Practice Paused' : roomName}
            </h2>
            <p className="text-xs text-[#cbbda4] mt-1">
              {role === 'host'
                ? 'Simulation continues syncing to connected WebRTC peers while you manage the room.'
                : role === 'client'
                  ? 'Connected via direct P2P WebRTC DataChannel.'
                  : 'Simulation paused · Press Esc or Resume to return.'}
            </p>
          </div>

          {role !== 'offline' && roomId && (
            <div className="p-4 rounded-lg bg-[#16233b] border border-[#d4a359]/30 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-[#cbbda4]">Room Code</div>
                  <div className="font-mono-num text-xl font-bold text-[#fef08a] tracking-wider">
                    {roomId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={copyInvite}
                  className="px-3.5 py-2 rounded-lg text-xs font-bold text-[#0b1120] bg-[#f59e0b] hover:bg-[#fbbf24] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {copied ? 'Invite URL Copied' : 'Copy Friend Invite Link'}
                </button>
              </div>

              <div className="border-t border-white/10 pt-2.5">
                <div className="text-xs font-semibold text-[#d9ccb6] mb-1.5">
                  WebRTC Connected Peers ({peers.length})
                </div>
                {peers.length === 0 ? (
                  <p className="text-xs text-[#94a3b8]">
                    Waiting for friends to join from the Open Rooms browser or via your invite link.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {peers.map((p) => (
                      <div
                        key={p.peerId}
                        className="flex items-center justify-between text-xs text-[#f1f5f9]"
                      >
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="font-mono-num text-[#cbd5e1]">
                          {p.dataChannelOpen ? `P2P Open · ${p.rttMs} ms` : p.connectionState}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {role !== 'client' && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-[#e2d6c1]">
                Active AI Bot Rivals
              </span>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#162238] border border-[#d4a359]/25">
                {[0, 1, 2, 3].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onChangeBotCount(n)}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
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
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onResume}
              className="flex-1 py-2.5 px-4 rounded-lg font-display font-bold text-sm text-[#0b1120] bg-[#f59e0b] hover:bg-[#fbbf24] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              Resume
            </button>
            {role !== 'client' && (
              <button
                type="button"
                onClick={onRestart}
                className="py-2.5 px-4 rounded-lg font-semibold text-sm text-[#fdfaf3] bg-[#1e2f4d] hover:bg-[#283d63] border border-[#d4a359]/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Restart Match
              </button>
            )}
            <button
              type="button"
              onClick={onReturnToTitle}
              className="py-2.5 px-4 rounded-lg font-semibold text-sm text-[#fca5a5] bg-[#2a1820] hover:bg-[#3d212d] border border-[#f87171]/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              Leave to Title
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 'gameover' Victory / Match Complete Modal
  const snap = summary;
  const isVictory = snap?.isLocalVictory ?? false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match Results"
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(8, 13, 24, 0.78)' }}
    >
      <div
        className="w-full max-w-lg rounded-xl p-6 border border-[#d4a359]/50 shadow-2xl flex flex-col gap-5"
        style={{ backgroundColor: 'rgba(14, 22, 38, 0.96)' }}
      >
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[#d4a359]">
            {isVictory ? 'Sunforge Champion' : 'Match Complete'}
          </div>
          <h2 className="font-display text-3xl font-extrabold text-[#fdfaf3] mt-0.5">
            {isVictory
              ? 'Victory in Helios Arena!'
              : `${snap?.winnerName ?? 'Champion'} Claims the Crown`}
          </h2>
        </div>

        {/* 3 Tabular Stat Tiles */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-[#16233b] border border-white/10">
            <div className="text-[11px] text-[#cbbda4]">Your Score</div>
            <div className="font-display font-mono-num text-2xl font-extrabold text-[#fef08a] mt-0.5">
              {snap?.localScore ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[#16233b] border border-white/10">
            <div className="text-[11px] text-[#cbbda4]">Ring-Out KOs</div>
            <div className="font-display font-mono-num text-2xl font-extrabold text-[#fdfaf3] mt-0.5">
              {snap?.localKnockouts ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[#16233b] border border-white/10">
            <div className="text-[11px] text-[#cbbda4]">Core Goals</div>
            <div className="font-display font-mono-num text-2xl font-extrabold text-[#38bdf8] mt-0.5">
              {snap?.localCoreGoals ?? 0}
            </div>
          </div>
        </div>

        {/* Final Standings Table */}
        {snap && snap.standings.length > 0 && (
          <div className="rounded-lg bg-[#131e33] border border-white/10 p-3.5 flex flex-col gap-2">
            <div className="text-xs font-semibold text-[#cbbda4]">
              Final Arena Standings
            </div>
            {snap.standings.map((row, idx) => (
              <div
                key={row.id}
                className="flex items-center justify-between text-sm py-1 border-t border-white/5 first:border-t-0"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="font-mono-num text-xs text-[#94a3b8] w-4">
                    {idx + 1}.
                  </span>
                  <span
                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: row.colorHex }}
                  />
                  <span
                    className={`truncate ${
                      row.isLocal ? 'font-bold text-[#fef08a]' : 'text-[#f1f5f9]'
                    }`}
                  >
                    {row.name}
                  </span>
                </div>
                <div className="font-mono-num text-xs text-[#cbd5e1] whitespace-nowrap shrink-0">
                  {row.score} pts · {row.knockouts} KO · {row.coreGoals} Goals
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {role !== 'client' ? (
            <button
              type="button"
              data-start="true"
              onClick={onRestart}
              className="flex-1 py-3 px-5 rounded-lg font-display font-bold text-sm text-[#0b1120] bg-[#f59e0b] hover:bg-[#fbbf24] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              Play Again
            </button>
          ) : (
            <div className="flex-1 text-xs text-[#cbbda4]">
              Waiting for Host to start the next round...
            </div>
          )}
          <button
            type="button"
            onClick={onReturnToTitle}
            className="py-3 px-4 rounded-lg font-semibold text-sm text-[#f3ead8] bg-[#1b2a44] hover:bg-[#243759] border border-[#d4a359]/35 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            Return to Title
          </button>
        </div>
      </div>
    </div>
  );
};
