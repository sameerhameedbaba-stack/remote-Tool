"use client";

import {
  Loader2,
  ShieldQuestion,
  WifiOff,
  PhoneOff,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { SessionConnectionState } from "@/lib/webrtc";
import { Button } from "@/components/ui";

// Full-canvas overlay describing the current connection state. Shown whenever
// the live video is not up, so the technician always knows what's happening.
export function ConnectionOverlay({
  connState,
  ended,
  bannerAcked,
  onReconnect,
  onBack,
}: {
  connState: SessionConnectionState;
  ended: boolean;
  bannerAcked: boolean;
  onReconnect: () => void;
  onBack: () => void;
}) {
  // Don't cover a healthy live session.
  if (connState === "connected" && !ended) return null;

  let icon = <Loader2 className="h-7 w-7 animate-spin text-accent" aria-hidden />;
  let title = "Connecting to the remote device…";
  let message = "Negotiating a secure peer-to-peer connection.";
  let action: React.ReactNode = null;

  if (ended || connState === "closed") {
    icon = <PhoneOff className="h-7 w-7 text-fg-muted" aria-hidden />;
    title = "Session ended";
    message = "The remote connection has been closed.";
    action = (
      <Button variant="secondary" onClick={onBack}>
        Back to devices
      </Button>
    );
  } else if (connState === "failed") {
    icon = <AlertTriangle className="h-7 w-7 text-danger" aria-hidden />;
    title = "Connection failed";
    message =
      "We couldn't establish the connection. The agent may be offline or the network may be blocking peer-to-peer traffic.";
    action = (
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back to devices
        </Button>
        <Button variant="primary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={onReconnect}>
          Reconnect
        </Button>
      </div>
    );
  } else if (connState === "reconnecting") {
    icon = <Loader2 className="h-7 w-7 animate-spin text-warning" aria-hidden />;
    title = "Reconnecting…";
    message =
      "The connection was interrupted. Trying to recover the peer-to-peer link automatically.";
    action = (
      <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={onReconnect}>
        Reconnect now
      </Button>
    );
  } else if (!bannerAcked && (connState === "connecting" || connState === "signaling")) {
    icon = <ShieldQuestion className="h-7 w-7 text-warning" aria-hidden />;
    title = "Waiting for user consent";
    message =
      "The end user must see and acknowledge the on-screen consent banner before the session can begin.";
  } else if (connState === "idle") {
    icon = <WifiOff className="h-7 w-7 text-fg-muted" aria-hidden />;
    title = "Preparing session…";
    message = "Setting up the secure channel.";
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
          {icon}
        </div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="mt-1.5 text-[13px] text-fg-secondary">{message}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
