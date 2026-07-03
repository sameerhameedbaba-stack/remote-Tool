"use client";

import { useEffect, useState } from "react";
import {
  Plug,
  FolderSync,
  Power,
  Eye,
  MousePointer2,
  ClipboardCopy,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  listAudit,
  listSessions,
  type AuditEvent,
  type Device,
  type Session,
} from "@/lib/api";
import {
  Drawer,
  Button,
  PresenceBadge,
  ModeBadge,
  SessionBadge,
  PermissionBadge,
  Divider,
  LoadingState,
  ConfirmDialog,
  StatusBadge,
} from "@/components/ui";
import { OsIcon, osLabel } from "./os";
import { AUDIT_META } from "./audit-meta";
import { formatTime, timeAgo } from "@/components/ui";

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-[13px]">
      <span className="text-fg-muted">{label}</span>
      <span className="truncate text-right font-medium text-fg">{value}</span>
    </div>
  );
}

export function DeviceDetailDrawer({
  device,
  open,
  onClose,
  onConnect,
  connecting,
}: {
  device: Device | null;
  open: boolean;
  onClose: () => void;
  onConnect: (device: Device) => void;
  connecting?: boolean;
}) {
  const { token } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  useEffect(() => {
    if (!open || !device || !token) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listSessions(token, { device_id: device.id, limit: 5 }),
      listAudit(token, { device_id: device.id, limit: 6 }),
    ])
      .then(([s, a]) => {
        if (cancelled) return;
        setSessions(s.sessions);
        setEvents(a.events);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, device, token]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={device ? device.name : "Device"}
      width="max-w-md"
    >
      {device && (
        <div className="space-y-6 p-5">
          {/* Identity + status */}
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-soft bg-surface text-fg-secondary">
              <OsIcon os={device.os} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">
                {device.name}
              </div>
              <div className="truncate text-[12px] text-fg-muted">
                {device.hostname}
              </div>
            </div>
            <div className="ml-auto flex flex-col items-end gap-1.5">
              <PresenceBadge status={device.status} size="sm" />
              <ModeBadge mode={device.mode} />
            </div>
          </div>

          {/* Primary actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              onClick={() => onConnect(device)}
              disabled={device.status !== "online"}
              loading={connecting}
              icon={!connecting && <Plug className="h-4 w-4" aria-hidden />}
              fullWidth
            >
              Start session
            </Button>
            <Button
              variant="secondary"
              onClick={() => onConnect(device)}
              disabled={device.status !== "online"}
              icon={<FolderSync className="h-4 w-4" aria-hidden />}
              fullWidth
            >
              File transfer
            </Button>
          </div>
          {device.status !== "online" && (
            <p className="-mt-3 text-[12px] text-fg-muted">
              Device is offline — actions available when its agent reconnects.
            </p>
          )}

          <Divider />

          {/* Details */}
          <div>
            <DetailRow label="Operating system" value={osLabel(device.os)} />
            <DetailRow label="Access mode" value={<ModeBadge mode={device.mode} />} />
            <DetailRow label="Agent version" value={device.app_version || "—"} />
            <DetailRow label="Last seen" value={timeAgo(device.last_seen_at)} />
            <DetailRow label="Registered" value={formatTime(device.created_at)} />
            <DetailRow
              label="Public IP"
              value={<span className="text-fg-muted">— {/* TODO: backend */}</span>}
            />
            <DetailRow
              label="Device ID"
              value={<span className="font-mono text-[12px]">{device.id.slice(0, 12)}…</span>}
            />
          </div>

          <Divider />

          {/* Permissions (session capabilities) */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
              <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
              Session permissions
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <Eye className="h-3 w-3" aria-hidden /> View screen
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <MousePointer2 className="h-3 w-3" aria-hidden /> Control input
              </span>
              <PermissionBadge label="File transfer" />
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <ClipboardCopy className="h-3 w-3" aria-hidden /> Clipboard
              </span>
            </div>
            <p className="mt-2 text-[11px] text-fg-muted">
              Per-device permission profiles are an admin policy (backend TODO).
            </p>
          </div>

          <Divider />

          {/* Recent sessions */}
          <div>
            <div className="mb-2 text-[13px] font-semibold text-fg">
              Recent sessions
            </div>
            {loading ? (
              <LoadingState rows={2} />
            ) : sessions.length === 0 ? (
              <p className="py-2 text-[12px] text-fg-muted">No sessions yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {sessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[12px] text-fg">
                        {s.id.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-fg-muted">
                        {s.type} · {formatTime(s.created_at)}
                      </div>
                    </div>
                    <SessionBadge status={s.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Recent audit */}
          <div>
            <div className="mb-2 text-[13px] font-semibold text-fg">
              Recent audit events
            </div>
            {loading ? (
              <LoadingState rows={2} />
            ) : events.length === 0 ? (
              <p className="py-2 text-[12px] text-fg-muted">
                No audit events for this device.
              </p>
            ) : (
              <ul className="space-y-1">
                {events.map((e) => {
                  const meta = AUDIT_META[e.event_type];
                  return (
                    <li
                      key={e.id}
                      className="flex items-center gap-2 py-1 text-[12px]"
                    >
                      <StatusBadge kind={meta.kind} size="sm" icon={meta.icon}>
                        {meta.label}
                      </StatusBadge>
                      <span className="ml-auto text-fg-muted">
                        {timeAgo(e.created_at)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Divider />

          {/* Danger zone */}
          <div>
            <Button
              variant="secondary"
              icon={<Power className="h-4 w-4 text-danger" aria-hidden />}
              onClick={() => setConfirmReboot(true)}
              disabled={device.status !== "online"}
            >
              Reboot device
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReboot}
        onClose={() => setConfirmReboot(false)}
        onConfirm={() => setConfirmReboot(false)}
        title="Reboot this device?"
        message="Remote reboot is not yet available — this is a placeholder for the upcoming agent power-control capability. No action will be taken."
        confirmLabel="Understood"
        tone="primary"
      />
    </Drawer>
  );
}
