"use client";

import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { Card } from "@/components/ui";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && (
          <p className="mt-1 text-[13px] text-fg-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

// A structured, on-brand placeholder for admin surfaces whose backend does not
// exist yet — honest about what's coming without shipping fake data.
export function PlaceholderCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-hover text-fg-secondary">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>
    </Card>
  );
}

export function ComingSoonPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-fg-muted">
      <Wrench className="h-3 w-3" aria-hidden />
      Backend TODO
    </span>
  );
}
