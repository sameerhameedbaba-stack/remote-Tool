"use client";

import {
  ShieldCheck,
  Circle,
  Video,
  Lock,
  MousePointerBan,
  User,
} from "lucide-react";
import type { Session } from "@/lib/api";
import type { SessionConnectionState } from "@/lib/webrtc";
import { ConnectionQualityIndicator, StatusDot } from "@/components/ui";
import { OsIcon } from "@/components/domain/os";
import { cn } from "@/lib/cn";

// Trust chip — a compact, icon+text indicator used across the session bar so
// every safety-relevant fact is visible at a glance (never color-only).
function Chip({
  icon,
  label,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
}) {
  const tones = {
    neutral: "text-fg-secondary",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    accent: "text-accent",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", tones[tone])}>
      {icon}
      {label}
    </span>
  );
}

export function SessionTopBar({
  session,
  sessionActive,
  deviceName,
  deviceOs,
  connState,
  elapsed,
  technicianName,
  bannerAcked,
  recording,
  inputDisabledRemote,
  screenLocked,
  latencyMs,
}: {
  session: Session | null;
  // Whether a remote session is in progress (backend session not ended) — drives
  // the mandatory red indicator, independent of the WebRTC transport state.
  sessionActive: boolean;
  deviceName: string;
  deviceOs: string;
  connState: SessionConnectionState;
  elapsed: string;
  technicianName: string;
  bannerAcked: boolean;
  recording: boolean;
  inputDisabledRemote: boolean;
  screenLocked: boolean;
  latencyMs: number | null;
}) {
  const connected = connState === "connected";
  const connLabel: Record<SessionConnectionState, string> = {
    idle: "Preparing…",
    signaling: "Negotiating…",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Closed",
    failed: "Connection failed",
  };
  const connTone =
    connState === "connected"
      ? "success"
      : connState === "failed" || connState === "closed"
        ? "danger"
        : "warning";

  return (
    <div className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
      {/* MANDATORY, non-dismissible live indicator. Reflects that a remote
          session is in progress on the machine (trust), separate from the
          transport state shown on the right. */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1 text-[12px] font-semibold",
          sessionActive ? "bg-danger text-white" : "bg-surface-hover text-fg-secondary",
        )}
      >
        <Circle
          className={cn(
            "h-2.5 w-2.5",
            sessionActive ? "animate-pulse fill-white" : "fill-fg-muted",
          )}
          aria-hidden
        />
        {sessionActive ? "REMOTE SESSION ACTIVE" : "Session ended — connection closed"}
      </div>

      {/* Device identity */}
      <div className="flex min-w-0 items-center gap-2">
        <OsIcon os={deviceOs} className="h-4 w-4 shrink-0 text-fg-muted" />
        <span className="truncate text-sm font-semibold text-fg">{deviceName}</span>
        {session && (
          <span className="hidden rounded-full bg-surface-hover px-2 py-0.5 text-[11px] capitalize text-fg-secondary sm:inline">
            {session.type}
          </span>
        )}
      </div>

      {/* Right-aligned live facts */}
      <div className="ml-auto flex items-center gap-4">
        <Chip
          icon={<StatusDot kind={connTone} pulse={connected} />}
          label={connLabel[connState]}
          tone={connTone}
        />
        {connected && <ConnectionQualityIndicator latencyMs={latencyMs} />}
        <span className="hidden items-center gap-1.5 text-[12px] tabular-nums text-fg-secondary md:flex">
          <Circle className="h-1.5 w-1.5 fill-fg-muted text-fg-muted" aria-hidden />
          {elapsed}
        </span>

        {/* Trust facts */}
        <div className="hidden items-center gap-3 border-l border-line pl-4 lg:flex">
          <Chip
            icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
            label={bannerAcked ? "Consent confirmed" : "Awaiting consent"}
            tone={bannerAcked ? "success" : "warning"}
          />
          {recording && (
            <Chip
              icon={<Video className="h-3.5 w-3.5" aria-hidden />}
              label="Recording"
              tone="danger"
            />
          )}
          {inputDisabledRemote && (
            <Chip icon={<MousePointerBan className="h-3.5 w-3.5" aria-hidden />} label="Input locked" tone="warning" />
          )}
          {screenLocked && (
            <Chip icon={<Lock className="h-3.5 w-3.5" aria-hidden />} label="Screen locked" tone="warning" />
          )}
          <Chip
            icon={<User className="h-3.5 w-3.5" aria-hidden />}
            label={technicianName}
            tone="neutral"
          />
        </div>
      </div>
    </div>
  );
}
