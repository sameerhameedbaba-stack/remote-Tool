"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  ApiError,
  createAttendedCode,
  listDevices,
  listSessions,
  type AttendedCodeResponse,
  type Device,
  type Session,
} from "@/lib/api";
import { SessionBadge, formatTime, useCountdown } from "@/components/ui";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="card">
      <div className="text-sm font-medium text-slate-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function AttendedCodePanel({
  code,
  onClear,
}: {
  code: AttendedCodeResponse;
  onClear: () => void;
}) {
  const { label, expired } = useCountdown(code.expires_at);
  return (
    <div className="card border-accent-500/40 bg-accent-500/5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium text-slate-300">
            One-time attended code
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Read this code to the end user. It is single-use and expires.
          </p>
        </div>
        <button onClick={onClear} className="btn-secondary text-xs">
          Dismiss
        </button>
      </div>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div
          className="font-mono text-4xl font-bold tracking-[0.2em] text-white"
          aria-label={`Attended code ${code.code}`}
        >
          {code.code}
        </div>
        <div className="text-right">
          <div
            className={`text-2xl font-semibold tabular-nums ${
              expired ? "text-red-400" : "text-accent-400"
            }`}
          >
            {expired ? "Expired" : label}
          </div>
          <div className="text-xs text-slate-500">
            expires {formatTime(code.expires_at)}
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardContent() {
  const { token } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [attendedCode, setAttendedCode] = useState<AttendedCodeResponse | null>(
    null,
  );
  const [creatingCode, setCreatingCode] = useState(false);
  const [label, setLabel] = useState("");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const [devRes, sesRes] = await Promise.all([
          listDevices(token, {}, signal),
          listSessions(token, { limit: 5 }, signal),
        ]);
        setDevices(devRes.devices);
        setSessions(sesRes.sessions);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "network_error") return;
        setError(err instanceof ApiError ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const onCreateCode = async () => {
    if (!token) return;
    setCreatingCode(true);
    setError(null);
    try {
      const res = await createAttendedCode(token, label.trim() || "Attended session");
      setAttendedCode(res);
      setLabel("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create code");
    } finally {
      setCreatingCode(false);
    }
  };

  const onlineCount = devices.filter((d) => d.status === "online").length;
  const activeSessions = sessions.filter((s) => s.status === "active").length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          <p className="text-sm text-slate-400">
            Overview of your fleet and support sessions
          </p>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Devices online"
          value={loading ? "…" : onlineCount}
          hint={`${devices.length} total registered`}
        />
        <StatCard
          label="Active sessions"
          value={loading ? "…" : activeSessions}
        />
        <StatCard
          label="Recent sessions"
          value={loading ? "…" : sessions.length}
          hint="most recent 5"
        />
        <StatCard
          label="Offline devices"
          value={loading ? "…" : devices.length - onlineCount}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Start attended session */}
        <div className="card">
          <h2 className="text-lg font-semibold text-white">
            Start attended session
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Generate a one-time code for a user running the portable agent.
          </p>
          <div className="mt-4 flex gap-2">
            <input
              className="input"
              placeholder="Label (e.g. Jane's laptop)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Session label"
            />
            <button
              onClick={onCreateCode}
              className="btn-primary whitespace-nowrap"
              disabled={creatingCode}
            >
              {creatingCode ? "Creating…" : "Create code"}
            </button>
          </div>

          {attendedCode && (
            <div className="mt-4">
              <AttendedCodePanel
                code={attendedCode}
                onClear={() => setAttendedCode(null)}
              />
            </div>
          )}
        </div>

        {/* Recent sessions */}
        <div className="card">
          <h2 className="text-lg font-semibold text-white">Recent sessions</h2>
          <div className="mt-4 divide-y divide-surface-700">
            {loading ? (
              <p className="py-4 text-sm text-slate-500">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="py-4 text-sm text-slate-500">No sessions yet.</p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/sessions/${s.id}`}
                      className="font-mono text-sm text-accent-400 hover:underline"
                    >
                      {s.id.slice(0, 8)}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {s.type} · {formatTime(s.created_at)}
                    </div>
                  </div>
                  <SessionBadge status={s.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
