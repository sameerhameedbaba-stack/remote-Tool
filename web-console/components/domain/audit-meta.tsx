"use client";

import type { ReactNode } from "react";
import {
  LogIn,
  ShieldAlert,
  MonitorSmartphone,
  Plug,
  ShieldCheck,
  Radio,
  Square,
  FileUp,
  ClipboardCopy,
  MousePointer2,
  CircleDot,
} from "lucide-react";
import type { AuditEventType } from "@/lib/api";
import type { StatusKind } from "@/components/ui";

export type Severity = "info" | "notice" | "warning";

interface AuditMeta {
  label: string;
  kind: StatusKind;
  severity: Severity;
  icon: ReactNode;
}

const ic = "h-3.5 w-3.5";

// Single source of truth for how each audit event renders (label, color, icon,
// severity). Keeps the drawer, timeline, and table perfectly consistent.
export const AUDIT_META: Record<AuditEventType, AuditMeta> = {
  "auth.login": {
    label: "Signed in",
    kind: "info",
    severity: "info",
    icon: <LogIn className={ic} aria-hidden />,
  },
  "auth.login_failed": {
    label: "Failed sign-in",
    kind: "warning",
    severity: "warning",
    icon: <ShieldAlert className={ic} aria-hidden />,
  },
  "device.register": {
    label: "Device registered",
    kind: "info",
    severity: "notice",
    icon: <MonitorSmartphone className={ic} aria-hidden />,
  },
  "session.request": {
    label: "Session requested",
    kind: "info",
    severity: "notice",
    icon: <Plug className={ic} aria-hidden />,
  },
  "session.approve": {
    label: "Consent approved",
    kind: "success",
    severity: "notice",
    icon: <ShieldCheck className={ic} aria-hidden />,
  },
  "session.start": {
    label: "Session started",
    kind: "success",
    severity: "notice",
    icon: <Radio className={ic} aria-hidden />,
  },
  "session.end": {
    label: "Session ended",
    kind: "neutral",
    severity: "info",
    icon: <Square className={ic} aria-hidden />,
  },
  "file.transfer": {
    label: "File transferred",
    kind: "info",
    severity: "notice",
    icon: <FileUp className={ic} aria-hidden />,
  },
  "clipboard.sync": {
    label: "Clipboard synced",
    kind: "neutral",
    severity: "info",
    icon: <ClipboardCopy className={ic} aria-hidden />,
  },
  "input.command_attempt": {
    label: "Remote input",
    kind: "warning",
    severity: "notice",
    icon: <MousePointer2 className={ic} aria-hidden />,
  },
};

export const AUDIT_EVENT_TYPES = Object.keys(AUDIT_META) as AuditEventType[];

// Safe accessor: audit event types arrive from the wire via an unchecked cast,
// so an unknown/new type must not crash the timeline, table, or device drawer.
// Falls back to a neutral, informative rendering keyed on the raw type string.
export function getAuditMeta(eventType: string): AuditMeta {
  const known = (AUDIT_META as Record<string, AuditMeta | undefined>)[eventType];
  if (known) return known;
  return {
    label: eventType,
    kind: "neutral",
    severity: "info",
    icon: <CircleDot className={ic} aria-hidden />,
  };
}

// Tailwind background class for a status kind — used for the timeline dots so
// the kind -> color mapping lives next to the rest of the audit rendering.
export const KIND_DOT: Record<StatusKind, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-neutral",
  accent: "bg-accent",
};

export function kindDotClass(kind: StatusKind): string {
  return KIND_DOT[kind] ?? KIND_DOT.neutral;
}
