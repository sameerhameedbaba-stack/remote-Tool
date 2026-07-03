"use client";

import { useEffect, useState } from "react";

// Format an RFC 3339 timestamp for display; falls back gracefully.
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Relative "time ago" for last-seen columns.
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

// Live-updating elapsed timer (mm:ss / h:mm:ss) since a start timestamp.
export function useElapsed(startedAt: string | null | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return "00:00";
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Live countdown to an expiry timestamp (mm:ss).
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
  if (!expiresAt) return { secondsLeft: 0, label: "—", expired: true };
  const target = new Date(expiresAt).getTime();
  const secondsLeft = Math.max(0, Math.floor((target - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return { secondsLeft, label: `${mm}:${ss}`, expired: secondsLeft <= 0 };
}
