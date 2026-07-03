"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  ApiError,
  createSession,
  listDevices,
  type Device,
} from "@/lib/api";
import { PresenceBadge, timeAgo } from "@/components/ui";

const PRESENCE_POLL_MS = 10_000;

function DevicesContent() {
  const { token } = useAuth();
  const router = useRouter();

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const res = await listDevices(token, {}, signal);
        setDevices(res.devices);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "network_error") return;
        setError(err instanceof ApiError ? err.message : "Failed to load devices");
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  // Initial load + presence polling.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => void load(), PRESENCE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load]);

  const onConnect = async (device: Device) => {
    if (!token) return;
    setConnectingId(device.id);
    setError(null);
    try {
      const res = await createSession(token, device.id);
      // Stash the ICE servers for the session page. GET /sessions/{id} does not
      // return ICE servers (per docs/API.md), so we carry them across the
      // client-side navigation via sessionStorage (survives a reload too).
      try {
        sessionStorage.setItem(
          `rs_ice:${res.session.id}`,
          JSON.stringify(res.ice_servers),
        );
      } catch {
        /* storage may be unavailable; the session page falls back gracefully */
      }
      router.push(`/sessions/${res.session.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Failed to start session",
      );
      setConnectingId(null);
    }
  };

  const filtered = devices.filter((d) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      d.name.toLowerCase().includes(q) ||
      d.hostname.toLowerCase().includes(q)
    );
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Devices</h1>
          <p className="text-sm text-slate-400">
            Registered endpoints and live presence
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input w-56"
            placeholder="Search name or hostname"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search devices"
          />
          <button
            onClick={() => void load()}
            className="btn-secondary"
            aria-label="Refresh"
          >
            Refresh
          </button>
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
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Hostname</th>
                <th className="px-4 py-3 font-medium">OS</th>
                <th className="px-4 py-3 font-medium">Mode</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800 bg-surface-900">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Loading devices…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No devices found.
                  </td>
                </tr>
              ) : (
                filtered.map((device) => {
                  const canConnect =
                    device.status === "online" &&
                    device.mode === "unattended";
                  return (
                    <tr key={device.id} className="hover:bg-surface-850">
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {device.name}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">
                        {device.hostname}
                      </td>
                      <td className="px-4 py-3 capitalize text-slate-300">
                        {device.os}
                      </td>
                      <td className="px-4 py-3 capitalize text-slate-300">
                        {device.mode}
                      </td>
                      <td className="px-4 py-3">
                        <PresenceBadge status={device.status} />
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {timeAgo(device.last_seen_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => void onConnect(device)}
                          className="btn-primary text-xs disabled:opacity-40"
                          disabled={!canConnect || connectingId === device.id}
                          title={
                            canConnect
                              ? "Start an unattended session"
                              : "Only online unattended devices can be connected"
                          }
                        >
                          {connectingId === device.id
                            ? "Connecting…"
                            : "Connect"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function DevicesPage() {
  return (
    <RequireAuth>
      <DevicesContent />
    </RequireAuth>
  );
}
