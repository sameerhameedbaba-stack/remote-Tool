"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  MonitorSmartphone,
  Radio,
  WifiOff,
  KeyRound,
  Copy,
  Check,
  Plug,
  ArrowRight,
  Search,
  Server,
  ExternalLink,
} from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  createAttendedCode,
  listDevices,
  listFleet,
  listSessions,
  errorMessage,
  isNetworkError,
  type AttendedCodeResponse,
  type Device,
  type FleetMember,
  type Session,
} from "@/lib/api";
import { startDeviceSession, PRESENCE_POLL_MS } from "@/lib/session-connect";
import {
  Button,
  Card,
  Field,
  Input,
  MetricCard,
  SectionHeading,
  EmptyState,
  LoadingState,
  PresenceBadge,
  SessionBadge,
  useCountdown,
  timeAgo,
  formatTime,
} from "@/components/ui";
import { OsIcon, osLabel } from "@/components/domain/os";
import { cn } from "@/lib/cn";

function AttendedCodeCard({
  code,
  onClear,
}: {
  code: AttendedCodeResponse;
  onClear: () => void;
}) {
  const { label, expired } = useCountdown(code.expires_at);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  // The end user opens the connect page (connect.<this-host>) and enters the
  // code; the page hands them a ready-to-run agent. Derived from the current
  // origin so it stays correct across deployments.
  const connectHost =
    typeof window !== "undefined" ? `connect.${window.location.host}` : "";
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-fg-secondary">
          Send the user to the connect page
        </span>
        <button
          onClick={onClear}
          className="text-[12px] text-fg-muted hover:text-fg"
        >
          Dismiss
        </button>
      </div>
      {connectHost && (
        <p className="mt-1 text-[12px] text-fg-muted">
          Tell them to open{" "}
          <span className="font-medium text-fg">{connectHost}</span> and enter
          this code — a ready-to-run app downloads, no install needed.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-4">
        <div
          className="font-mono text-3xl font-semibold tracking-[0.15em] text-fg"
          aria-label={`Attended code ${code.code}`}
        >
          {code.code}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div
              className={cn(
                "text-lg font-semibold tabular-nums",
                expired ? "text-danger" : "text-accent",
              )}
            >
              {expired ? "Expired" : label}
            </div>
            <div className="text-[11px] text-fg-muted">single-use · expires</div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={copy}
            icon={
              copied ? (
                <Check className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )
            }
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// FleetCard shows the RustDesk-managed machines (the ones that ran the branded
// client and stay online for unattended access) with live presence. Connect
// opens the RustDesk client via its documented rustdesk:// URI on the
// technician's own machine.
function FleetCard({
  members,
  enabled,
  unavailable,
  loading,
}: {
  members: FleetMember[];
  enabled: boolean;
  unavailable: boolean;
  loading: boolean;
}) {
  const online = members.filter((m) => m.online).length;
  return (
    <Card className="mt-6 p-0">
      <div className="flex items-center justify-between px-5 pt-5">
        <SectionHeading
          title="Unattended machines"
          description="Computers running your branded client — online status, connect anytime."
        />
        {enabled && !unavailable && members.length > 0 && (
          <span className="text-[12px] text-fg-muted">
            {online} online · {members.length} total
          </span>
        )}
      </div>
      <div className="mt-3">
        {loading ? (
          <LoadingState rows={3} />
        ) : !enabled ? (
          <EmptyState
            icon={<Server className="h-5 w-5" aria-hidden />}
            title="Fleet not connected yet"
            description="Once your RustDesk server API token is configured, the machines that install your branded client appear here with live on/off status."
          />
        ) : unavailable ? (
          <EmptyState
            icon={<Server className="h-5 w-5" aria-hidden />}
            title="Fleet temporarily unavailable"
            description="Couldn't reach the RustDesk server just now — retrying automatically. Your other dashboard data is unaffected."
          />
        ) : members.length === 0 ? (
          <EmptyState
            icon={<Server className="h-5 w-5" aria-hidden />}
            title="No machines yet"
            description="Send a user your branded installer. After they run it once, the machine stays here for unattended access."
          />
        ) : (
          <ul className="divide-y divide-line">
            {members.map((m, i) => (
              <li
                key={m.rustdesk_id || `${m.hostname}-${i}`}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
              >
                <OsIcon os={m.os} className="h-4 w-4 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">
                    {m.hostname || m.rustdesk_id}
                  </div>
                  <div className="truncate text-[12px] text-fg-muted">
                    ID {m.rustdesk_id}
                    {m.username ? ` · ${m.username}` : ""}
                    {!m.online && m.last_seen
                      ? ` · seen ${timeAgo(m.last_seen)}`
                      : ""}
                  </div>
                </div>
                <PresenceBadge
                  status={m.online ? "online" : "offline"}
                  size="sm"
                />
                {m.online ? (
                  <a
                    href={`rustdesk://connection/new/${encodeURIComponent(m.rustdesk_id)}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent/90"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    Connect
                  </a>
                ) : (
                  // Offline: render a non-actionable span (not a focusable link)
                  // so keyboard users can't fire the rustdesk:// URI for an
                  // unreachable machine.
                  <span
                    className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-surface-hover px-3 py-1.5 text-[13px] font-medium text-fg-muted opacity-60"
                    aria-disabled
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    Connect
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function DashboardContent() {
  const { token } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [fleet, setFleet] = useState<FleetMember[]>([]);
  const [fleetEnabled, setFleetEnabled] = useState(false);
  const [fleetUnavailable, setFleetUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [attendedCode, setAttendedCode] = useState<AttendedCodeResponse | null>(
    null,
  );
  const [creatingCode, setCreatingCode] = useState(false);
  const [label, setLabel] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      // Core data (devices + sessions) governs the page. Its failure surfaces
      // the error banner.
      try {
        const [devRes, sesRes] = await Promise.all([
          listDevices(token, {}, signal),
          listSessions(token, { limit: 8 }, signal),
        ]);
        setDevices(devRes.devices);
        setSessions(sesRes.sessions);
        setError(null);
      } catch (err) {
        if (!isNetworkError(err)) {
          setError(errorMessage(err, "Failed to load data"));
        }
      } finally {
        setLoading(false);
      }

      // Fleet (RustDesk) is a SECONDARY integration: fetch it separately so a
      // RustDesk outage degrades only this panel and never blanks the core
      // dashboard or raises the page-level error banner.
      try {
        const fleetRes = await listFleet(token, signal);
        setFleet(fleetRes.members);
        setFleetEnabled(fleetRes.enabled);
        setFleetUnavailable(fleetRes.unavailable === true);
      } catch (err) {
        if (!isNetworkError(err)) {
          setFleetUnavailable(true);
        }
      }
    },
    [token],
  );

  useEffect(() => {
    // Each cycle (initial + every poll) gets its own AbortController so an
    // in-flight request is cancelled on unmount and slow polls don't overlap.
    let current: AbortController | null = null;
    const run = () => {
      current?.abort();
      current = new AbortController();
      void load(current.signal);
    };
    run();
    const id = setInterval(run, PRESENCE_POLL_MS);
    return () => {
      current?.abort();
      clearInterval(id);
    };
  }, [load]);

  // Palette "Start attended session" deep-link focuses the label field.
  useEffect(() => {
    if (search.get("attended") === "1") labelRef.current?.focus();
  }, [search]);

  const onCreateCode = async () => {
    if (!token) return;
    setCreatingCode(true);
    setError(null);
    try {
      const res = await createAttendedCode(
        token,
        label.trim() || "Attended session",
      );
      setAttendedCode(res);
      setLabel("");
    } catch (err) {
      setError(errorMessage(err, "Failed to create code"));
    } finally {
      setCreatingCode(false);
    }
  };

  const connect = async (device: Device) => {
    if (!token) return;
    setConnectingId(device.id);
    try {
      const session = await startDeviceSession(token, device.id);
      router.push(`/sessions/${session.id}`);
    } catch (err) {
      setError(errorMessage(err, "Failed to start session"));
      setConnectingId(null);
    }
  };

  const onlineDevices = devices.filter((d) => d.status === "online");
  const activeSessions = sessions.filter((s) => s.status === "active");
  const openCommand = () =>
    window.dispatchEvent(new Event("rs:open-command"));

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Dashboard
          </h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            Your fleet at a glance — connect, monitor, and support.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={openCommand}
          icon={<Search className="h-4 w-4" aria-hidden />}
        >
          Connect a device
        </Button>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Devices online"
          value={loading ? "—" : onlineDevices.length}
          tone="success"
          icon={<MonitorSmartphone className="h-5 w-5" aria-hidden />}
          hint={`${devices.length} registered`}
        />
        <MetricCard
          label="Active sessions"
          value={loading ? "—" : activeSessions.length}
          tone={activeSessions.length > 0 ? "accent" : "neutral"}
          icon={<Radio className="h-5 w-5" aria-hidden />}
          hint="live now"
        />
        <MetricCard
          label="Offline"
          value={loading ? "—" : devices.length - onlineDevices.length}
          tone="neutral"
          icon={<WifiOff className="h-5 w-5" aria-hidden />}
        />
        <MetricCard
          label="Recent sessions"
          value={loading ? "—" : sessions.length}
          tone="info"
          icon={<Plug className="h-5 w-5" aria-hidden />}
          hint="last 8"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Attended session start */}
        <Card className="lg:col-span-1 p-5">
          <SectionHeading
            title="Start attended session"
            description="Generate a one-time code for a user running the portable agent."
          />
          <div className="mt-4">
            <Field label="Session label" htmlFor="attended-label">
              <div className="flex gap-2">
                <Input
                  id="attended-label"
                  ref={labelRef}
                  aria-label="Session label"
                  placeholder="e.g. Jane's laptop"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onCreateCode()}
                />
                <Button
                  variant="primary"
                  onClick={onCreateCode}
                  loading={creatingCode}
                  icon={
                    !creatingCode && <KeyRound className="h-4 w-4" aria-hidden />
                  }
                  className="whitespace-nowrap"
                >
                  Create code
                </Button>
              </div>
            </Field>
          </div>
          {attendedCode && (
            <AttendedCodeCard
              code={attendedCode}
              onClear={() => setAttendedCode(null)}
            />
          )}
        </Card>

        {/* Online devices quick connect */}
        <Card className="lg:col-span-2 p-0">
          <div className="flex items-center justify-between px-5 pt-5">
            <SectionHeading
              title="Online devices"
              description="One-click unattended connect."
            />
            <Link
              href="/devices"
              className="flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
            >
              All devices <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
          <div className="mt-3">
            {loading ? (
              <LoadingState rows={3} />
            ) : onlineDevices.length === 0 ? (
              <EmptyState
                icon={<WifiOff className="h-5 w-5" aria-hidden />}
                title="No devices online"
                description="Devices appear here when their agent is connected."
              />
            ) : (
              <ul className="divide-y divide-line">
                {onlineDevices.slice(0, 5).map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
                  >
                    <OsIcon os={d.os} className="h-4 w-4 text-fg-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">
                        {d.name}
                      </div>
                      <div className="truncate text-[12px] text-fg-muted">
                        {d.hostname} · {osLabel(d.os)} · seen {timeAgo(d.last_seen_at)}
                      </div>
                    </div>
                    <PresenceBadge status={d.status} size="sm" />
                    <Button
                      size="sm"
                      variant="primary"
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Unattended fleet (RustDesk-managed) */}
      <FleetCard
        members={fleet}
        enabled={fleetEnabled}
        unavailable={fleetUnavailable}
        loading={loading}
      />

      {/* Recent sessions */}
      <Card className="mt-6 p-0">
        <div className="px-5 pt-5">
          <SectionHeading
            title="Recent sessions"
            description="Latest support activity across your organization."
          />
        </div>
        <div className="mt-3">
          {loading ? (
            <LoadingState rows={3} />
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={<Radio className="h-5 w-5" aria-hidden />}
              title="No sessions yet"
              description="Start a session from a device or an attended code to see it here."
            />
          ) : (
            <ul className="divide-y divide-line">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/sessions/${s.id}`}
                      className="font-mono text-[13px] font-medium text-accent hover:underline"
                    >
                      {s.id.slice(0, 8)}
                    </Link>
                    <div className="text-[12px] text-fg-muted">
                      {s.type} · {formatTime(s.created_at)}
                    </div>
                  </div>
                  <SessionBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<LoadingState className="min-h-[60vh]" />}>
        <DashboardContent />
      </Suspense>
    </RequireAuth>
  );
}
