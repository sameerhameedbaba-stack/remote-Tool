"use client";

import type { ReactNode } from "react";
import {
  CircleDot,
  Wifi,
  WifiOff,
  ShieldCheck,
  ShieldAlert,
  Radio,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { DeviceStatus, SessionStatus } from "@/lib/api";

// Status kinds map 1:1 to the functional color system. Every badge shows an
// icon AND text AND color — never color alone (accessibility + trust).
export type StatusKind =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "accent";

const kindStyles: Record<StatusKind, string> = {
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-fg-secondary",
  accent: "bg-accent-soft text-accent",
};

export function StatusBadge({
  kind,
  icon,
  children,
  className,
  size = "md",
}: {
  kind: StatusKind;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]",
        kindStyles[kind],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// A small solid status dot, optionally pulsing (for live/online).
export function StatusDot({
  kind,
  pulse,
  className,
}: {
  kind: StatusKind;
  pulse?: boolean;
  className?: string;
}) {
  const color: Record<StatusKind, string> = {
    info: "bg-info",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    neutral: "bg-neutral",
    accent: "bg-accent",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        color[kind],
        pulse && "animate-pulse-ring",
        className,
      )}
    />
  );
}

export function PresenceBadge({
  status,
  size = "md",
}: {
  status: DeviceStatus;
  size?: "sm" | "md";
}) {
  const online = status === "online";
  return (
    <StatusBadge
      kind={online ? "success" : "neutral"}
      size={size}
      icon={
        online ? (
          <Wifi className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
        )
      }
    >
      {online ? "Online" : "Offline"}
    </StatusBadge>
  );
}

export function SessionBadge({ status }: { status: SessionStatus }) {
  const map: Record<
    SessionStatus,
    { kind: StatusKind; label: string; icon: ReactNode }
  > = {
    active: {
      kind: "success",
      label: "Active",
      icon: <Radio className="h-3.5 w-3.5" aria-hidden />,
    },
    pending: {
      kind: "warning",
      label: "Pending",
      icon: <Clock className="h-3.5 w-3.5" aria-hidden />,
    },
    ended: {
      kind: "neutral",
      label: "Ended",
      icon: <CircleDot className="h-3.5 w-3.5" aria-hidden />,
    },
  };
  const s = map[status];
  return (
    <StatusBadge kind={s.kind} icon={s.icon}>
      {s.label}
    </StatusBadge>
  );
}

// Mode badge — attended (consent) vs unattended (installed service).
export function ModeBadge({ mode }: { mode: string }) {
  const attended = mode === "attended";
  return (
    <StatusBadge
      kind={attended ? "info" : "neutral"}
      size="sm"
      icon={
        attended ? (
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        )
      }
    >
      {attended ? "Attended" : "Unattended"}
    </StatusBadge>
  );
}

// PermissionBadge — a granted/required capability chip.
export function PermissionBadge({
  label,
  granted = true,
}: {
  label: string;
  granted?: boolean;
}) {
  return (
    <StatusBadge kind={granted ? "success" : "neutral"} size="sm">
      {label}
    </StatusBadge>
  );
}

// ConnectionQualityIndicator — signal bars + latency, colored by health.
// Never color-only: always accompanied by the latency text.
export function ConnectionQualityIndicator({
  latencyMs,
  className,
}: {
  latencyMs: number | null;
  className?: string;
}) {
  const level =
    latencyMs === null
      ? 0
      : latencyMs < 60
        ? 3
        : latencyMs < 150
          ? 2
          : 1;
  const kind: StatusKind =
    level === 3 ? "success" : level === 2 ? "warning" : level === 1 ? "danger" : "neutral";
  const barColor =
    kind === "success"
      ? "bg-success"
      : kind === "warning"
        ? "bg-warning"
        : kind === "danger"
          ? "bg-danger"
          : "bg-neutral";
  const label =
    latencyMs === null ? "—" : level === 3 ? "Strong" : level === 2 ? "Fair" : "Weak";
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="flex items-end gap-0.5" aria-hidden>
        {[1, 2, 3].map((b) => (
          <span
            key={b}
            className={cn(
              "w-1 rounded-sm",
              b === 1 ? "h-1.5" : b === 2 ? "h-2.5" : "h-3.5",
              b <= level ? barColor : "bg-line-soft",
            )}
          />
        ))}
      </span>
      <span className="text-[12px] tabular-nums text-fg-secondary">
        {label}
        {latencyMs !== null && (
          <span className="ml-1 text-fg-muted">{latencyMs}ms</span>
        )}
      </span>
    </span>
  );
}
