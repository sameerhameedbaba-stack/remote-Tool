"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Search,
  Monitor,
  LayoutDashboard,
  ScrollText,
  Plus,
  CornerDownLeft,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  ApiError,
  createSession,
  listDevices,
  type Device,
} from "@/lib/api";
import { PresenceBadge, ModeBadge } from "@/components/ui";
import { osLabel, OsIcon } from "@/components/domain/os";
import { cn } from "@/lib/cn";

// Global quick-connect + navigation palette. Open with ⌘K / Ctrl+K.
// The single fastest path for a technician: type a device name, Enter to connect.
export function CommandPalette() {
  const { token } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      // Allow other components to request the palette.
      if (e.key === "Escape") setOpen(false);
    };
    const openEvt = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("rs:open-command", openEvt as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rs:open-command", openEvt as EventListener);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  // Debounced device search.
  useEffect(() => {
    if (!open || !token) return;
    const ctl = new AbortController();
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await listDevices(token, { q: query || undefined }, ctl.signal);
        setDevices(res.devices.slice(0, 6));
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "network_error")) {
          setDevices([]);
        }
      } finally {
        setLoading(false);
      }
    }, 160);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [query, open, token]);

  const connect = useCallback(
    async (device: Device) => {
      if (!token || device.status !== "online") {
        router.push("/devices");
        setOpen(false);
        return;
      }
      setConnectingId(device.id);
      try {
        const res = await createSession(token, device.id);
        try {
          sessionStorage.setItem(
            `rs_ice:${res.session.id}`,
            JSON.stringify(res.ice_servers),
          );
        } catch {
          /* ignore */
        }
        setOpen(false);
        router.push(`/sessions/${res.session.id}`);
      } catch {
        router.push(`/devices`);
        setOpen(false);
      } finally {
        setConnectingId(null);
      }
    },
    [token, router],
  );

  const navItems = [
    { label: "Go to Dashboard", icon: LayoutDashboard, run: () => router.push("/dashboard") },
    { label: "Go to Devices", icon: Monitor, run: () => router.push("/devices") },
    { label: "Go to Audit log", icon: ScrollText, run: () => router.push("/audit") },
    { label: "Start attended session", icon: Plus, run: () => router.push("/dashboard?attended=1") },
  ];

  // Flattened selectable rows for keyboard nav: devices first, then actions.
  const rows: Array<{ kind: "device"; device: Device } | { kind: "action"; run: () => void }> = [
    ...devices.map((d) => ({ kind: "device" as const, device: d })),
    ...navItems.map((n) => ({ kind: "action" as const, run: n.run })),
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (!row) return;
      if (row.kind === "device") void connect(row.device);
      else {
        row.run();
        setOpen(false);
      }
    }
  };

  if (!open || !token) return null;

  return <PaletteBody />;

  function PaletteBody() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    return createPortal(
      <div className="fixed inset-0 z-[120] flex items-start justify-center px-4 pt-[12vh]">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={() => setOpen(false)}
          aria-hidden
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick connect"
          className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-pop animate-scale-in"
        >
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="h-4 w-4 text-fg-muted" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search a device to connect, or jump to…"
              className="h-12 w-full bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-fg-muted" aria-hidden />}
          </div>

          <div className="max-h-[52vh] overflow-y-auto p-2">
            {devices.length > 0 && (
              <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                Devices
              </div>
            )}
            {rows.map((row, i) => {
              if (row.kind === "device") {
                const d = row.device;
                const busy = connectingId === d.id;
                return (
                  <button
                    key={d.id}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void connect(d)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active === i ? "bg-surface-hover" : "hover:bg-surface-hover",
                    )}
                  >
                    <OsIcon os={d.os} className="h-4 w-4 shrink-0 text-fg-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">
                        {d.name}
                      </div>
                      <div className="truncate text-[12px] text-fg-muted">
                        {d.hostname} · {osLabel(d.os)}
                      </div>
                    </div>
                    <PresenceBadge status={d.status} size="sm" />
                    <ModeBadge mode={d.mode} />
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
                    ) : d.status === "online" ? (
                      <span className="flex items-center gap-1 text-[11px] text-fg-muted">
                        Connect <CornerDownLeft className="h-3 w-3" aria-hidden />
                      </span>
                    ) : null}
                  </button>
                );
              }
              const n = navItems[i - devices.length];
              const Icon = n.icon;
              return (
                <button
                  key={n.label}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    n.run();
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    active === i ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover",
                  )}
                >
                  <Icon className="h-4 w-4 text-fg-muted" aria-hidden />
                  {n.label}
                </button>
              );
            })}
            {!loading && rows.length === 0 && (
              <div className="px-3 py-8 text-center text-[13px] text-fg-muted">
                No devices match “{query}”.
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-fg-muted">
            <span className="flex items-center gap-2">
              <kbd className="rounded border border-line-soft bg-surface px-1">↑↓</kbd> navigate
              <kbd className="rounded border border-line-soft bg-surface px-1">↵</kbd> connect
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-line-soft bg-surface px-1">esc</kbd> close
            </span>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
}
