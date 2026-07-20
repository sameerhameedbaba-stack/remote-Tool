"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  MonitorSmartphone,
  WifiOff,
  KeyRound,
  Copy,
  Check,
  Plug,
  Search,
  Server,
  ExternalLink,
  Download,
} from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  createAttendedCode,
  listFleet,
  technicianAppUrl,
  errorMessage,
  isNetworkError,
  type AttendedCodeResponse,
  type FleetMember,
} from "@/lib/api";
import { PRESENCE_POLL_MS } from "@/lib/session-connect";
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
  useCountdown,
  timeAgo,
} from "@/components/ui";
import { OsIcon } from "@/components/domain/os";
import { apexDomain } from "@/lib/tenant";
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
  // The end user opens the customer page — the apex domain root (tiefixy.com) —
  // and enters the code; the page validates it and hands them the branded
  // client. Derived from the current host so it stays correct across tenants.
  const joinUrl = apexDomain();
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-fg-secondary">
          Send the customer to your download page
        </span>
        <button
          onClick={onClear}
          className="text-[12px] text-fg-muted hover:text-fg"
        >
          Dismiss
        </button>
      </div>
      {joinUrl && (
        <p className="mt-1 text-[12px] text-fg-muted">
          Tell them to open{" "}
          <span className="font-medium text-fg">{joinUrl}</span> and enter this
          code — your branded app downloads, no install fuss.
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
  const search = useSearchParams();
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
  const labelRef = useRef<HTMLInputElement>(null);

  // The dashboard is now entirely RustDesk-fleet driven.
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const fleetRes = await listFleet(token, signal);
        setFleet(fleetRes.members);
        setFleetEnabled(fleetRes.enabled);
        setFleetUnavailable(fleetRes.unavailable === true);
        setError(null);
      } catch (err) {
        if (!isNetworkError(err)) {
          setFleetUnavailable(true);
        }
      } finally {
        setLoading(false);
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

  const onlineFleet = fleet.filter((m) => m.online);
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
        <div className="flex items-center gap-2">
          <a
            href={technicianAppUrl()}
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover"
            title="Install this on your own computer to control remote PCs"
          >
            <Download className="h-4 w-4" aria-hidden />
            Technician app
          </a>
          <Button
            variant="primary"
            onClick={openCommand}
            icon={<Search className="h-4 w-4" aria-hidden />}
          >
            Connect a device
          </Button>
        </div>
      </div>

      {/* Metrics — all from the live RustDesk fleet */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard
          label="Machines online"
          value={loading ? "—" : onlineFleet.length}
          tone="success"
          icon={<MonitorSmartphone className="h-5 w-5" aria-hidden />}
          hint={`${fleet.length} total`}
        />
        <MetricCard
          label="Offline"
          value={loading ? "—" : fleet.length - onlineFleet.length}
          tone="neutral"
          icon={<WifiOff className="h-5 w-5" aria-hidden />}
        />
        <MetricCard
          label="Total machines"
          value={loading ? "—" : fleet.length}
          tone="info"
          icon={<Plug className="h-5 w-5" aria-hidden />}
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

      {/* Create a support code — customer enters it at your download page */}
      <Card className="mt-6 p-5">
        <SectionHeading
          title="Start a support session"
          description="Generate a one-time code. The customer enters it at your download page (tiefixy.com) to get your branded app."
        />
        <div className="mt-4 max-w-xl">
          <Field label="Label (optional)" htmlFor="attended-label">
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

      {/* Unattended fleet (RustDesk-managed) — the main machine list */}
      <FleetCard
        members={fleet}
        enabled={fleetEnabled}
        unavailable={fleetUnavailable}
        loading={loading}
      />
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
