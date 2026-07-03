"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { StatusKind } from "./status";

// MetricCard — a single, calm KPI tile. Restrained: number-forward, one accent
// icon, optional status accent. No decorative gradients.
export function MetricCard({
  label,
  value,
  icon,
  tone = "neutral",
  hint,
  loading,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: StatusKind;
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const iconTone: Record<StatusKind, string> = {
    info: "bg-info-soft text-info",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    neutral: "bg-surface-hover text-fg-secondary",
    accent: "bg-accent-soft text-accent",
  };
  return (
    <div
      className={cn(
        "surface-card flex items-center gap-4 p-4 shadow-elev-1",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
            iconTone[tone],
          )}
        >
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[12px] font-medium uppercase tracking-wide text-fg-muted">
          {label}
        </div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-fg">
          {loading ? <span className="text-fg-muted">—</span> : value}
        </div>
        {hint && <div className="mt-0.5 text-[12px] text-fg-muted">{hint}</div>}
      </div>
    </div>
  );
}
