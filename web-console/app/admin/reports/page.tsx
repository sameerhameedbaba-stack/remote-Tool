"use client";

import {
  Clock,
  Users,
  MonitorSmartphone,
  Receipt,
  Download,
  BarChart3,
} from "lucide-react";
import { RequireAuth } from "@/lib/auth";
import { Button } from "@/components/ui";
import { PageHeader, PlaceholderCard, ComingSoonPill } from "@/components/domain/admin";

function ReportsContent() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      <PageHeader
        title="Reports"
        description="Operational and billing-ready insight across your fleet and team."
        action={
          <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} disabled>
            Export CSV
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard
          icon={<Clock className="h-5 w-5" aria-hidden />}
          title="Session duration"
          description="Average and total session time by technician, device, and day — the basis for SLA and billing reports."
        >
          <ComingSoonPill />
        </PlaceholderCard>
        <PlaceholderCard
          icon={<Users className="h-5 w-5" aria-hidden />}
          title="Technician activity"
          description="Sessions handled, response times, and utilization per technician."
        >
          <ComingSoonPill />
        </PlaceholderCard>
        <PlaceholderCard
          icon={<MonitorSmartphone className="h-5 w-5" aria-hidden />}
          title="Device usage"
          description="Most-supported devices, uptime, and recurring-issue hotspots."
        >
          <ComingSoonPill />
        </PlaceholderCard>
        <PlaceholderCard
          icon={<Receipt className="h-5 w-5" aria-hidden />}
          title="Billing-ready export"
          description="Per-seat and per-session usage rolled up for invoicing, exportable to CSV."
        >
          <ComingSoonPill />
        </PlaceholderCard>
      </div>

      <div className="mt-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-soft bg-surface-card px-6 py-16 text-center">
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-surface-hover text-fg-muted">
          <BarChart3 className="h-6 w-6" aria-hidden />
        </div>
        <h3 className="text-sm font-semibold text-fg">Reporting engine coming soon</h3>
        <p className="mt-1 max-w-md text-[13px] text-fg-muted">
          Charts render from an aggregation API that isn&apos;t built yet. The
          audit log already captures the underlying events, so these reports are a
          reporting-layer addition — not new instrumentation.
        </p>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <RequireAuth>
      <ReportsContent />
    </RequireAuth>
  );
}
