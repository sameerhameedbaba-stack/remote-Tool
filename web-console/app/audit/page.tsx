"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ScrollText,
  Download,
  ChevronLeft,
  ChevronRight,
  Rows3,
  ListTree,
} from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  listAudit,
  errorMessage,
  isNetworkError,
  type AuditEvent,
  type AuditEventType,
} from "@/lib/api";
import {
  Card,
  Input,
  Select,
  Button,
  IconButton,
  Tabs,
  Tooltip,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  Field,
  formatTime,
  timeAgo,
} from "@/components/ui";
import {
  AUDIT_META,
  AUDIT_EVENT_TYPES,
  getAuditMeta,
  kindDotClass,
} from "@/components/domain/audit-meta";
import { cn } from "@/lib/cn";

const SEVERITY_TONE = {
  info: "neutral",
  notice: "info",
  warning: "warning",
} as const;

function actor(e: AuditEvent): string {
  const parts: string[] = [];
  if (e.technician_id) parts.push(`tech ${e.technician_id.slice(0, 8)}`);
  if (e.device_id) parts.push(`device ${e.device_id.slice(0, 8)}`);
  if (e.session_id) parts.push(`session ${e.session_id.slice(0, 8)}`);
  return parts.join(" · ") || "system";
}

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  // Objects/arrays would stringify to "[object Object]"; serialize instead.
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function metaSummary(e: AuditEvent): string {
  const m = e.metadata || {};
  const keys = Object.keys(m);
  if (keys.length === 0) return "";
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${formatMetaValue(m[k])}`)
    .join("  ");
}

function AuditContent() {
  const { token } = useAuth();

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"timeline" | "table">("timeline");

  const [eventType, setEventType] = useState<AuditEventType | "">("");
  // Raw text-field state drives the inputs; the *applied* values (debounced)
  // drive the request, so typing doesn't fire a request per keystroke.
  const [deviceId, setDeviceId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [deviceIdApplied, setDeviceIdApplied] = useState("");
  const [sessionIdApplied, setSessionIdApplied] = useState("");

  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>([]);

  const load = useCallback(
    async (activeCursor: string | null, signal?: AbortSignal) => {
      if (!token) return;
      setLoading(true);
      try {
        const res = await listAudit(
          token,
          {
            event_type: eventType || undefined,
            device_id: deviceIdApplied.trim() || undefined,
            session_id: sessionIdApplied.trim() || undefined,
            cursor: activeCursor ?? undefined,
            limit: 50,
          },
          signal,
        );
        setEvents(res.events);
        setNextCursor(res.next_cursor);
        setError(null);
      } catch (err) {
        if (isNetworkError(err)) return;
        setError(errorMessage(err, "Failed to load audit log"));
      } finally {
        setLoading(false);
      }
    },
    [token, eventType, deviceIdApplied, sessionIdApplied],
  );

  // Debounce the free-text filters (~250ms), mirroring the devices page.
  useEffect(() => {
    const t = setTimeout(() => {
      setDeviceIdApplied(deviceId);
      setSessionIdApplied(sessionId);
    }, 250);
    return () => clearTimeout(t);
  }, [deviceId, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setCursor(null);
    setPrevCursors([]);
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  const onNext = () => {
    if (!nextCursor) return;
    setPrevCursors((prev) => [...prev, cursor]);
    setCursor(nextCursor);
    void load(nextCursor);
  };
  const onPrev = () => {
    if (prevCursors.length === 0) return;
    const previous = prevCursors[prevCursors.length - 1];
    setPrevCursors((prev) => prev.slice(0, -1));
    setCursor(previous);
    void load(previous);
  };

  // Group by calendar day for the timeline.
  const grouped = useMemo(() => {
    const groups: { day: string; items: AuditEvent[] }[] = [];
    for (const e of events) {
      const day = new Date(e.created_at).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(e);
      else groups.push({ day, items: [e] });
    }
    return groups;
  }, [events]);

  const EventBadge = ({ e }: { e: AuditEvent }) => {
    const meta = getAuditMeta(e.event_type);
    return (
      <StatusBadge kind={meta.kind} size="sm" icon={meta.icon}>
        <span data-testid="audit-event">{meta.label}</span>
      </StatusBadge>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Audit log
          </h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            Immutable, append-only record of every session and sensitive action.
          </p>
        </div>
        <Tooltip label="CSV export is coming soon">
          <Button
            variant="secondary"
            icon={<Download className="h-4 w-4" aria-hidden />}
            disabled
          >
            Export
          </Button>
        </Tooltip>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Event type" htmlFor="f-type">
            <Select
              id="f-type"
              value={eventType}
              onChange={(e) => setEventType(e.target.value as AuditEventType | "")}
            >
              <option value="">All events</option>
              {AUDIT_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {AUDIT_META[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Device ID" htmlFor="f-device">
            <Input
              id="f-device"
              placeholder="Filter by device…"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
          </Field>
          <Field label="Session ID" htmlFor="f-session">
            <Input
              id="f-session"
              placeholder="Filter by session…"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </Field>
          <div className="flex items-end justify-between gap-2">
            <Tabs
              items={[
                { id: "timeline", label: "Timeline", icon: <ListTree className="h-3.5 w-3.5" /> },
                { id: "table", label: "Table", icon: <Rows3 className="h-3.5 w-3.5" /> },
              ]}
              active={view}
              onChange={(v) => setView(v as "timeline" | "table")}
              size="sm"
            />
          </div>
        </div>
      </Card>

      {/* Content */}
      <Card className="mt-4 p-0">
        {loading ? (
          <LoadingState rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load(cursor)} />
        ) : events.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-5 w-5" aria-hidden />}
            title="No audit events"
            description="Events appear here as technicians sign in and run sessions."
          />
        ) : view === "timeline" ? (
          <div className="p-5">
            {grouped.map((group) => (
              <div key={group.day} className="mb-6 last:mb-0">
                <div className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-fg-muted">
                  {group.day}
                </div>
                <ol className="relative space-y-3 pl-6">
                  <span className="absolute left-[9px] top-1 h-[calc(100%-0.5rem)] w-px bg-line" aria-hidden />
                  {group.items.map((e) => {
                    const meta = getAuditMeta(e.event_type);
                    return (
                      <li key={e.id} className="relative" data-testid="audit-row">
                        <span
                          className={cn(
                            "absolute -left-6 top-1 grid h-[18px] w-[18px] place-items-center rounded-full border-2 border-surface-card",
                            kindDotClass(meta.kind),
                          )}
                          aria-hidden
                        />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <EventBadge e={e} />
                          <StatusBadge
                            kind={SEVERITY_TONE[meta.severity]}
                            size="sm"
                          >
                            {meta.severity}
                          </StatusBadge>
                          <span className="text-[12px] text-fg-muted">
                            {actor(e)}
                          </span>
                          <span className="ml-auto text-[12px] tabular-nums text-fg-muted">
                            {formatTime(e.created_at)} · {timeAgo(e.created_at)}
                          </span>
                        </div>
                        {metaSummary(e) && (
                          <div className="mt-1 font-mono text-[11px] text-fg-muted">
                            {metaSummary(e)}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-fg-muted">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Event</th>
                  <th className="px-4 py-2.5 font-medium">Session</th>
                  <th className="px-4 py-2.5 font-medium">Device</th>
                  <th className="px-4 py-2.5 font-medium">Technician</th>
                  <th className="px-4 py-2.5 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr
                    key={e.id}
                    data-testid="audit-row"
                    className="align-top transition-colors hover:bg-surface-hover"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-[13px] text-fg-secondary">
                      {formatTime(e.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <EventBadge e={e} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-fg-muted">
                      {e.session_id ? e.session_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-fg-muted">
                      {e.device_id ? e.device_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-fg-muted">
                      {e.technician_id ? e.technician_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-muted">
                      {metaSummary(e) || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {!loading && events.length > 0 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3">
            <span className="text-[12px] text-fg-muted">
              {events.length} events on this page
            </span>
            <div className="flex items-center gap-1">
              <IconButton
                label="Previous page"
                variant="secondary"
                size="sm"
                disabled={prevCursors.length === 0}
                onClick={onPrev}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </IconButton>
              <IconButton
                label="Next page"
                variant="secondary"
                size="sm"
                disabled={!nextCursor}
                onClick={onNext}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </IconButton>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AuditPage() {
  return (
    <RequireAuth>
      <AuditContent />
    </RequireAuth>
  );
}
