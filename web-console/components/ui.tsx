"use client";

import { useEffect, useState } from "react";
import type { DeviceStatus, SessionStatus } from "@/lib/api";

// Online/offline presence badge.
export function PresenceBadge({ status }: { status: DeviceStatus }) {
  const online = status === "online";
  return (
    <span
      className={`badge ${
        online
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-slate-500/15 text-slate-400"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          online ? "bg-emerald-400" : "bg-slate-500"
        }`}
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}

// Session status badge.
export function SessionBadge({ status }: { status: SessionStatus }) {
  const map: Record<SessionStatus, string> = {
    active: "bg-emerald-500/15 text-emerald-300",
    pending: "bg-amber-500/15 text-amber-300",
    ended: "bg-slate-500/15 text-slate-400",
  };
  return <span className={`badge ${map[status]}`}>{status}</span>;
}

// Format an RFC 3339 timestamp for display; falls back gracefully.
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

// Relative "time ago" helper for last-seen columns.
export function timeAgo(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Live countdown to an expiry timestamp. Returns seconds remaining (>= 0) and
// a formatted mm:ss string.
export function useCountdown(expiresAt: string | null): {
  secondsLeft: number;
  label: string;
  expired: boolean;
} {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!expiresAt) {
    return { secondsLeft: 0, label: "—", expired: true };
  }
  const target = new Date(expiresAt).getTime();
  const secondsLeft = Math.max(0, Math.floor((target - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return {
    secondsLeft,
    label: `${mm}:${ss}`,
    expired: secondsLeft <= 0,
  };
}
