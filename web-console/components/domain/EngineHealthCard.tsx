"use client";

import { Card, SectionHeading, formatTime, timeAgo } from "@/components/ui";
import type { ProbeState, RustDeskHealth } from "@/lib/api";
import { cn } from "@/lib/cn";

// Why this card exists: the fleet list proves the RustDesk *console API*
// answers. It says nothing about the ports a session actually needs — so a
// technician can be told "Failed to connect via rendezvous server" while every
// other panel on this page is green. This card watches those ports directly, so
// "it failed at 14:32" becomes something you can look up instead of argue about.

const STATE_LABEL: Record<ProbeState, string> = {
  ok: "Accepting connections",
  refused: "Nothing listening",
  timeout: "No answer",
  error: "Unreachable",
};

const STATE_TONE: Record<ProbeState, string> = {
  ok: "bg-success-soft text-success",
  refused: "bg-danger-soft text-danger",
  timeout: "bg-danger-soft text-danger",
  error: "bg-warning-soft text-warning",
};

export function EngineHealthCard({
  health,
  loading,
}: {
  health: RustDeskHealth | null;
  loading: boolean;
}) {
  // Nothing to watch (RustDesk not wired in): stay silent rather than showing a
  // scary empty panel on a platform that simply isn't using the engine yet.
  if (!loading && (!health || !health.enabled)) return null;

  const latest = health?.latest;
  const summary = health?.summary;
  const allOK = latest?.ok ?? true;
  const everChecked = (summary?.checks ?? 0) > 0;

  return (
    <Card className="mt-6 p-5">
      <SectionHeading
        title="Connection engine"
        description="The ports a remote session needs, checked from inside your server."
        action={
          everChecked ? (
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                allOK
                  ? "bg-success-soft text-success"
                  : "bg-danger-soft text-danger",
              )}
            >
              {allOK ? "All ports OK" : "Problem right now"}
            </span>
          ) : undefined
        }
      />

      {loading && !health ? (
        <p className="mt-4 text-[13px] text-fg-muted">Checking…</p>
      ) : !everChecked ? (
        <p className="mt-4 text-[13px] text-fg-muted">
          Starting up — the first check runs within a minute.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-1.5">
            {latest?.results.map((r) => (
              <li
                key={r.name}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    r.state === "ok" ? "bg-success" : "bg-danger",
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg">
                    {r.role}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg-muted">
                    port {r.port}
                    {r.state === "ok" ? ` · ${r.ms}ms` : ""}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                    STATE_TONE[r.state],
                  )}
                >
                  {STATE_LABEL[r.state]}
                </span>
              </li>
            ))}
          </ul>

          <HistoryStrip health={health!} />

          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-fg-muted">
            <span>
              <span className="font-medium text-fg-secondary">
                {summary?.ok_percent}% healthy
              </span>{" "}
              over the last {summary?.window_hours}h
            </span>
            <span>
              {summary?.failures === 0
                ? "No failed checks"
                : `${summary?.failures} failed of ${summary?.checks} checks`}
            </span>
            {summary?.last_failure_at && (
              <span>Last problem {timeAgo(summary.last_failure_at)}</span>
            )}
          </div>

          {health!.outages.length > 0 && (
            <details className="mt-3 border-t border-line pt-3">
              <summary className="cursor-pointer text-[12px] font-medium text-fg-secondary">
                {health!.outages.length} problem
                {health!.outages.length === 1 ? "" : "s"} in the last{" "}
                {summary?.window_hours}h
              </summary>
              <ul className="mt-2 space-y-1">
                {[...health!.outages].reverse().map((o, i) => (
                  <li
                    key={`${o.from}-${i}`}
                    className="font-mono text-[11px] text-fg-muted"
                  >
                    {formatTime(o.from)} → {formatTime(o.to)} ·{" "}
                    {o.ports.join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

// A 24-hour strip: one cell per 15 minutes, so a technician's reported time can
// be pointed at directly. Grey = no data (the backend restarted and the history
// is in memory only), green = every check passed, red = at least one failed.
function HistoryStrip({ health }: { health: RustDeskHealth }) {
  if (health.buckets.length === 0) return null;
  return (
    <div className="mt-4">
      <div
        className="flex h-6 gap-px overflow-hidden rounded"
        role="img"
        aria-label={`Connection health over the last ${health.summary.window_hours} hours`}
      >
        {health.buckets.map((b) => (
          <div
            key={b.at}
            title={
              b.total === 0
                ? `${formatTime(b.at)} — no data`
                : `${formatTime(b.at)} — ${b.total - b.failed}/${b.total} checks OK`
            }
            className={cn(
              "flex-1",
              b.total === 0
                ? "bg-line"
                : b.failed > 0
                  ? "bg-danger"
                  : "bg-success",
            )}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-muted">
        <span>{health.summary.window_hours}h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
