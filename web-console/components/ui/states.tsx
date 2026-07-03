"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, Skeleton, Spinner } from "./primitives";

// EmptyState — used on every list/table when there is nothing to show.
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl border border-line-soft bg-surface text-fg-muted">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// LoadingState — inline spinner + label, or a set of shimmer rows.
export function LoadingState({
  label = "Loading…",
  rows,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  if (rows) {
    return (
      <div className={cn("space-y-2 p-2", className)} aria-busy>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 px-6 py-14 text-[13px] text-fg-muted",
        className,
      )}
      aria-busy
    >
      <Spinner />
      {label}
    </div>
  );
}

// ErrorState — a clear, recoverable failure surface.
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-danger-soft text-danger">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {message && (
        <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{message}</p>
      )}
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-5"
          icon={<RefreshCw className="h-4 w-4" aria-hidden />}
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </div>
  );
}

// Inline alert banner (form errors, warnings).
export function Alert({
  kind = "danger",
  children,
  className,
}: {
  kind?: "danger" | "warning" | "info" | "success";
  children: ReactNode;
  className?: string;
}) {
  const styles: Record<string, string> = {
    danger: "border-danger/30 bg-danger-soft text-danger",
    warning: "border-warning/30 bg-warning-soft text-warning",
    info: "border-info/30 bg-info-soft text-info",
    success: "border-success/30 bg-success-soft text-success",
  };
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]",
        styles[kind],
        className,
      )}
    >
      {children}
    </div>
  );
}
