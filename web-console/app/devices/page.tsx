"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Star,
  Plug,
  ChevronRight,
  MonitorSmartphone,
  Rows3,
  LayoutGrid,
  RotateCw,
} from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  listDevices,
  errorMessage,
  isNetworkError,
  type Device,
} from "@/lib/api";
import { startDeviceSession, PRESENCE_POLL_MS } from "@/lib/session-connect";
import {
  Button,
  IconButton,
  Card,
  Input,
  Tabs,
  Tooltip,
  PresenceBadge,
  ModeBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  timeAgo,
} from "@/components/ui";
import { OsIcon, osLabel } from "@/components/domain/os";
import { DeviceDetailDrawer } from "@/components/domain/DeviceDetailDrawer";
import { useFavorites } from "@/lib/favorites";
import { cn } from "@/lib/cn";

type Filter =
  | "all"
  | "online"
  | "offline"
  | "favorites"
  | "windows"
  | "macos"
  | "linux";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online" },
  { id: "offline", label: "Offline" },
  { id: "favorites", label: "Favorites" },
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

function DevicesContent() {
  const { token } = useAuth();
  const router = useRouter();
  const { isFavorite, toggle } = useFavorites();

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  // `error` is reserved for list-load failures (full-bleed ErrorState).
  const [error, setError] = useState<string | null>(null);
  // `actionError` surfaces connect() failures in a banner above the table so a
  // failed session start never wipes the device list.
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"table" | "cards">("table");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Device | null>(null);

  const load = useCallback(
    async (q: string, signal?: AbortSignal) => {
      if (!token) return;
      try {
        const res = await listDevices(token, { q: q || undefined }, signal);
        setDevices(res.devices);
        setError(null);
      } catch (err) {
        if (isNetworkError(err)) return;
        setError(errorMessage(err, "Failed to load devices"));
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  // Debounced server-side search + presence polling.
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => void load(query, ctl.signal), 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, load]);

  useEffect(() => {
    const id = setInterval(() => void load(query), PRESENCE_POLL_MS);
    return () => clearInterval(id);
  }, [load, query]);

  const filtered = useMemo(() => {
    return devices.filter((d) => {
      switch (filter) {
        case "online":
          return d.status === "online";
        case "offline":
          return d.status === "offline";
        case "favorites":
          return isFavorite(d.id);
        case "windows":
        case "macos":
        case "linux":
          return d.os === filter;
        default:
          return true;
      }
    });
  }, [devices, filter, isFavorite]);

  const connect = async (device: Device) => {
    if (!token) return;
    setActionError(null);
    setConnectingId(device.id);
    try {
      const session = await startDeviceSession(token, device.id);
      router.push(`/sessions/${session.id}`);
    } catch (err) {
      // Route to the action banner (NOT `error`) so the list stays rendered.
      setActionError(errorMessage(err, "Failed to start session"));
      setConnectingId(null);
    }
  };

  const onlineCount = devices.filter((d) => d.status === "online").length;

  const FavStar = ({ id }: { id: string }) => (
    <IconButton
      label={isFavorite(id) ? "Remove favorite" : "Add favorite"}
      size="sm"
      variant="ghost"
      onClick={(e) => {
        e.stopPropagation();
        toggle(id);
      }}
    >
      <Star
        className={cn(
          "h-4 w-4",
          isFavorite(id) ? "fill-warning text-warning" : "text-fg-muted",
        )}
        aria-hidden
      />
    </IconButton>
  );

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Devices
          </h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            {devices.length} registered · {onlineCount} online
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden
          />
          <Input
            aria-label="Search devices"
            placeholder="Search by name or hostname…"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Tabs
          items={[
            { id: "table", label: "Table", icon: <Rows3 className="h-3.5 w-3.5" /> },
            { id: "cards", label: "Cards", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
          ]}
          active={view}
          onChange={(v) => setView(v as "table" | "cards")}
          size="sm"
        />
        <Tooltip label="Refresh">
          <IconButton
            label="Refresh devices"
            variant="secondary"
            onClick={() => void load(query)}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
          </IconButton>
        </Tooltip>
      </div>

      {/* Filter chips */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
              filter === f.id
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-surface text-fg-secondary hover:border-line-soft hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {actionError && (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="shrink-0 text-[12px] font-medium text-danger/80 hover:text-danger"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content */}
      <Card className="mt-4 p-0">
        {loading ? (
          <LoadingState rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load(query)} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<MonitorSmartphone className="h-5 w-5" aria-hidden />}
            title={query ? "No matching devices" : "No devices yet"}
            description={
              query
                ? "Try a different search term or clear the filters."
                : "Enrolled agents appear here. Register an unattended device to get started."
            }
          />
        ) : view === "table" ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-fg-muted">
                  <th className="w-10 px-3 py-2.5" />
                  <th className="px-3 py-2.5 font-medium">Device</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Access</th>
                  <th className="px-3 py-2.5 font-medium">Last seen</th>
                  <th className="px-3 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => setDetail(d)}
                    className="cursor-pointer transition-colors hover:bg-surface-hover"
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <FavStar id={d.id} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <OsIcon os={d.os} className="h-4 w-4 shrink-0 text-fg-muted" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-fg">
                            {d.name}
                          </div>
                          <div className="truncate text-[12px] text-fg-muted">
                            {d.hostname} · {osLabel(d.os)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <PresenceBadge status={d.status} size="sm" />
                    </td>
                    <td className="px-3 py-2.5">
                      <ModeBadge mode={d.mode} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[13px] text-fg-secondary">
                      {timeAgo(d.last_seen_at)}
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant={d.status === "online" ? "primary" : "secondary"}
                          disabled={d.status !== "online"}
                          loading={connectingId === d.id}
                          onClick={() => void connect(d)}
                          icon={
                            connectingId !== d.id && (
                              <Plug className="h-3.5 w-3.5" aria-hidden />
                            )
                          }
                        >
                          Connect
                        </Button>
                        <IconButton
                          label="Device details"
                          size="sm"
                          variant="ghost"
                          onClick={() => setDetail(d)}
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((d) => (
              <div
                key={d.id}
                onClick={() => setDetail(d)}
                className="cursor-pointer rounded-xl border border-line bg-surface p-4 transition-all hover:border-line-soft hover:shadow-elev-2"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="grid h-9 w-9 place-items-center rounded-lg border border-line-soft bg-surface-card text-fg-secondary">
                      <OsIcon os={d.os} className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-fg">
                        {d.name}
                      </div>
                      <div className="truncate text-[12px] text-fg-muted">
                        {d.hostname}
                      </div>
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <FavStar id={d.id} />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <PresenceBadge status={d.status} size="sm" />
                  <ModeBadge mode={d.mode} />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[12px] text-fg-muted">
                    seen {timeAgo(d.last_seen_at)}
                  </span>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant={d.status === "online" ? "primary" : "secondary"}
                      disabled={d.status !== "online"}
                      loading={connectingId === d.id}
                      onClick={() => void connect(d)}
                      icon={
                        connectingId !== d.id && (
                          <Plug className="h-3.5 w-3.5" aria-hidden />
                        )
                      }
                    >
                      Connect
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <DeviceDetailDrawer
        device={detail}
        open={!!detail}
        onClose={() => setDetail(null)}
        onConnect={(d) => void connect(d)}
        connecting={connectingId === detail?.id}
      />
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
