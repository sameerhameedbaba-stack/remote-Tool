"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import { StatusDot } from "@/components/ui";
import { cn } from "@/lib/cn";

// RelayHealthPill — surfaces backend/relay reachability. It pings /readyz (real)
// and presents a calm system-status line. Per-relay latency/capacity metrics are
// a backend TODO (there is no relay-metrics endpoint yet).
type Health = "ok" | "degraded" | "down" | "checking";

export function RelayHealthPill({ className }: { className?: string }) {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/readyz`, {
          cache: "no-store",
        });
        if (!cancelled) setHealth(res.ok ? "ok" : "degraded");
      } catch {
        if (!cancelled) setHealth("down");
      }
    };
    void check();
    const id = setInterval(check, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const map = {
    ok: { kind: "success" as const, label: "All systems operational" },
    degraded: { kind: "warning" as const, label: "Service degraded" },
    down: { kind: "danger" as const, label: "Backend unreachable" },
    checking: { kind: "neutral" as const, label: "Checking status…" },
  };
  const s = map[health];
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2",
        className,
      )}
    >
      <StatusDot kind={s.kind} pulse={health === "ok"} />
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-fg-secondary">
          {s.label}
        </div>
        <div className="text-[11px] text-fg-muted">Relay &amp; signaling</div>
      </div>
    </div>
  );
}
