"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  ApiError,
  listAudit,
  type AuditEvent,
  type AuditEventType,
} from "@/lib/api";
import { formatTime } from "@/components/ui";

const EVENT_TYPES: AuditEventType[] = [
  "auth.login",
  "auth.login_failed",
  "device.register",
  "session.request",
  "session.approve",
  "session.start",
  "session.end",
  "file.transfer",
  "clipboard.sync",
  "input.command_attempt",
];

function eventColor(type: AuditEventType): string {
  if (type.startsWith("auth")) return "bg-blue-500/15 text-blue-300";
  if (type === "session.end") return "bg-slate-500/15 text-slate-300";
  if (type.startsWith("session")) return "bg-emerald-500/15 text-emerald-300";
  if (type === "device.register") return "bg-violet-500/15 text-violet-300";
  return "bg-amber-500/15 text-amber-300";
}

function AuditContent() {
  const { token } = useAuth();

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [eventType, setEventType] = useState<AuditEventType | "">("");
  const [deviceId, setDeviceId] = useState("");
  const [sessionId, setSessionId] = useState("");

  // Cursor pagination: stack of cursors so we can go back a page.
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
            device_id: deviceId.trim() || undefined,
            session_id: sessionId.trim() || undefined,
            cursor: activeCursor ?? undefined,
            limit: 50,
          },
          signal,
        );
        setEvents(res.events);
        setNextCursor(res.next_cursor);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "network_error") return;
        setError(err instanceof ApiError ? err.message : "Failed to load audit log");
      } finally {
        setLoading(false);
      }
    },
    [token, eventType, deviceId, sessionId],
  );

  // Reload from the first page whenever filters change.
  useEffect(() => {
    const controller = new AbortController();
    setCursor(null);
    setPrevCursors([]);
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  const onApplyFilters = () => {
    setCursor(null);
    setPrevCursors([]);
    void load(null);
  };

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

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Audit log</h1>
        <p className="text-sm text-slate-400">
          Append-only record of every session lifecycle and sensitive action
        </p>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label htmlFor="event-type" className="label">
              Event type
            </label>
            <select
              id="event-type"
              className="input"
              value={eventType}
              onChange={(e) =>
                setEventType(e.target.value as AuditEventType | "")
              }
            >
              <option value="">All events</option>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="device-id" className="label">
              Device ID
            </label>
            <input
              id="device-id"
              className="input"
              placeholder="uuid"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="session-id" className="label">
              Session ID
            </label>
            <input
              id="session-id"
              className="input"
              placeholder="uuid"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button onClick={onApplyFilters} className="btn-primary w-full">
              Apply filters
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-surface-700">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-surface-700 text-sm">
            <thead className="bg-surface-850 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Event</th>
                <th className="px-4 py-3 font-medium">Session</th>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">Technician</th>
                <th className="px-4 py-3 font-medium">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800 bg-surface-900">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Loading events…
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No audit events match these filters.
                  </td>
                </tr>
              ) : (
                events.map((ev) => (
                  <tr key={ev.id} className="align-top hover:bg-surface-850">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {formatTime(ev.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge ${eventColor(ev.event_type)}`}>
                        {ev.event_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {ev.session_id ? ev.session_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {ev.device_id ? ev.device_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {ev.technician_id ? ev.technician_id.slice(0, 8) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {Object.keys(ev.metadata ?? {}).length > 0
                        ? JSON.stringify(ev.metadata)
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={onPrev}
          className="btn-secondary"
          disabled={prevCursors.length === 0 || loading}
        >
          ← Previous
        </button>
        <span className="text-xs text-slate-500">
          {events.length} event{events.length === 1 ? "" : "s"} on this page
        </span>
        <button
          onClick={onNext}
          className="btn-secondary"
          disabled={!nextCursor || loading}
        >
          Next →
        </button>
      </div>
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
