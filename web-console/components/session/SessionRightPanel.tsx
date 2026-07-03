"use client";

import { useEffect, useRef, useState } from "react";
import {
  Info,
  MessageSquare,
  FolderSync,
  ClipboardCopy,
  ListTree,
  StickyNote,
  Upload,
  AlertTriangle,
  Check,
  X,
  Loader2,
  ArrowUpRight,
} from "lucide-react";
import type { Session } from "@/lib/api";
import type { SessionConnectionState } from "@/lib/webrtc";
import {
  Button,
  IconButton,
  Field,
  Textarea,
  StatusBadge,
  ConnectionQualityIndicator,
} from "@/components/ui";
import { cn } from "@/lib/cn";

export type PanelTab = "info" | "chat" | "files" | "clipboard" | "audit" | "notes";

export interface FileItem {
  id: string;
  name: string;
  size: number;
  status: "queued" | "sending" | "sent" | "failed" | "blocked";
  danger: boolean;
}

const DANGEROUS = [".exe", ".msi", ".bat", ".ps1", ".sh", ".cmd", ".scr"];

function isDangerous(name: string) {
  const lower = name.toLowerCase();
  return DANGEROUS.some((ext) => lower.endsWith(ext));
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TABS: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
  { id: "info", label: "Info", icon: <Info className="h-4 w-4" aria-hidden /> },
  { id: "files", label: "Files", icon: <FolderSync className="h-4 w-4" aria-hidden /> },
  { id: "clipboard", label: "Clipboard", icon: <ClipboardCopy className="h-4 w-4" aria-hidden /> },
  { id: "chat", label: "Chat", icon: <MessageSquare className="h-4 w-4" aria-hidden /> },
  { id: "audit", label: "Activity", icon: <ListTree className="h-4 w-4" aria-hidden /> },
  { id: "notes", label: "Notes", icon: <StickyNote className="h-4 w-4" aria-hidden /> },
];

export function SessionRightPanel({
  tab,
  onTab,
  session,
  sessionId,
  deviceName,
  connState,
  elapsed,
  technicianName,
  latencyMs,
  bannerAcked,
  activity,
  clipboardIn,
  onSyncClipboard,
  onSendFile,
  files,
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  session: Session | null;
  sessionId: string;
  deviceName: string;
  connState: SessionConnectionState;
  elapsed: string;
  technicianName: string;
  latencyMs: number | null;
  bannerAcked: boolean;
  activity: string[];
  clipboardIn: string;
  onSyncClipboard: () => void;
  onSendFile: (file: File) => void;
  files: FileItem[];
}) {
  return (
    <div className="flex h-full w-full flex-col bg-surface">
      {/* Tab rail */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            aria-selected={tab === t.id}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors",
              tab === t.id
                ? "bg-surface-hover text-fg"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {t.icon}
            <span className="hidden xl:inline">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "info" && (
          <InfoPanel
            session={session}
            sessionId={sessionId}
            deviceName={deviceName}
            connState={connState}
            elapsed={elapsed}
            technicianName={technicianName}
            latencyMs={latencyMs}
            bannerAcked={bannerAcked}
          />
        )}
        {tab === "files" && <FilesPanel files={files} onSendFile={onSendFile} />}
        {tab === "clipboard" && (
          <ClipboardPanel clipboardIn={clipboardIn} onSync={onSyncClipboard} />
        )}
        {tab === "chat" && <ChatPanel />}
        {tab === "audit" && <ActivityPanel activity={activity} />}
        {tab === "notes" && <NotesPanel sessionId={sessionId} />}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="text-fg-muted">{label}</span>
      <span className="truncate text-right font-medium text-fg">{value}</span>
    </div>
  );
}

function InfoPanel({
  session,
  sessionId,
  deviceName,
  connState,
  elapsed,
  technicianName,
  latencyMs,
  bannerAcked,
}: {
  session: Session | null;
  sessionId: string;
  deviceName: string;
  connState: SessionConnectionState;
  elapsed: string;
  technicianName: string;
  latencyMs: number | null;
  bannerAcked: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface-card p-3">
        <div className="mb-1 text-[12px] font-medium text-fg-muted">Connection</div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold capitalize text-fg">{connState}</span>
          <ConnectionQualityIndicator latencyMs={latencyMs} />
        </div>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface-card px-3">
        <Row label="Device" value={deviceName} />
        <Row label="Session" value={<span className="font-mono text-[12px]">{sessionId.slice(0, 12)}…</span>} />
        <Row label="Type" value={<span className="capitalize">{session?.type ?? "—"}</span>} />
        <Row label="Elapsed" value={<span className="tabular-nums">{elapsed}</span>} />
        <Row
          label="Consent"
          value={
            bannerAcked ? (
              <StatusBadge kind="success" size="sm">Confirmed</StatusBadge>
            ) : (
              <StatusBadge kind="warning" size="sm">Pending</StatusBadge>
            )
          }
        />
        <Row label="Resolution" value={<span className="text-fg-muted">— {/* TODO */}</span>} />
        <Row label="FPS" value={<span className="text-fg-muted">— {/* TODO */}</span>} />
        <Row label="Technician" value={technicianName} />
      </div>
      <p className="text-[11px] text-fg-muted">
        Resolution and FPS are surfaced once the agent screen source streams video
        (agent capture is a Windows TODO).
      </p>
    </div>
  );
}

function FilesPanel({
  files,
  onSendFile,
}: {
  files: FileItem[];
  onSendFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (isDangerous(file.name)) setPending(file);
    else onSendFile(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-soft bg-surface-card px-4 py-8 text-center transition-colors hover:border-accent hover:bg-accent-soft/30"
      >
        <Upload className="h-6 w-6 text-fg-muted" aria-hidden />
        <span className="text-[13px] font-medium text-fg">Send a file to the remote</span>
        <span className="text-[12px] text-fg-muted">
          Click to browse. Files land in the agent&apos;s downloads folder.
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => choose(e.target.files?.[0])}
      />

      {pending && (
        <div className="rounded-xl border border-warning/40 bg-warning-soft p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="text-[12px] text-fg">
              <div className="font-semibold text-warning">Potentially executable file</div>
              <p className="mt-0.5 text-fg-secondary">
                <span className="font-mono">{pending.name}</span> can run code on the
                remote machine. Only send it if you trust the source.
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                onSendFile(pending);
                setPending(null);
              }}
            >
              Send anyway
            </Button>
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="font-semibold text-fg">Transfer queue</span>
          <span className="text-fg-muted">local → remote</span>
        </div>
        {files.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface-card px-3 py-6 text-center text-[12px] text-fg-muted">
            No transfers yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-card px-3 py-2"
              >
                <ArrowUpRight className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg">{f.name}</div>
                  <div className="text-[11px] text-fg-muted">{fmtBytes(f.size)}</div>
                </div>
                {f.status === "sending" && <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />}
                {f.status === "sent" && <Check className="h-4 w-4 text-success" aria-hidden />}
                {f.status === "failed" && <X className="h-4 w-4 text-danger" aria-hidden />}
                {f.status === "queued" && <span className="text-[11px] text-fg-muted">queued</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-fg-muted">
        Downloads from the remote will appear here once the agent supports
        outbound file transfer (protocol defined; agent side is a TODO).
      </p>
    </div>
  );
}

function ClipboardPanel({
  clipboardIn,
  onSync,
}: {
  clipboardIn: string;
  onSync: () => void;
}) {
  return (
    <div className="space-y-4">
      <Button variant="primary" fullWidth onClick={onSync} icon={<ClipboardCopy className="h-4 w-4" aria-hidden />}>
        Sync my clipboard to remote
      </Button>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-fg-secondary">From remote</div>
        {clipboardIn ? (
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-card p-3 font-mono text-[12px] text-fg">
            {clipboardIn}
          </div>
        ) : (
          <p className="rounded-lg border border-line bg-surface-card px-3 py-6 text-center text-[12px] text-fg-muted">
            Nothing received from the remote clipboard yet.
          </p>
        )}
      </div>
      <p className="text-[11px] text-fg-muted">Text-only, and every sync is audited.</p>
    </div>
  );
}

function ChatPanel() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center rounded-xl border border-line bg-surface-card p-6 text-center">
        <div>
          <MessageSquare className="mx-auto mb-2 h-6 w-6 text-fg-muted" aria-hidden />
          <p className="text-[13px] font-medium text-fg">In-session chat</p>
          <p className="mt-1 text-[12px] text-fg-muted">
            Chat needs a dedicated data channel, which is on the roadmap. The
            input, clipboard and file channels are live today.
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          disabled
          placeholder="Chat coming soon…"
          className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg-muted"
        />
        <Button disabled size="sm" variant="secondary">Send</Button>
      </div>
    </div>
  );
}

function ActivityPanel({ activity }: { activity: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [activity]);
  if (activity.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface-card px-3 py-8 text-center text-[12px] text-fg-muted">
        Session activity will appear here in real time.
      </p>
    );
  }
  return (
    <ol className="relative space-y-3 pl-4">
      <span className="absolute left-[5px] top-1 h-[calc(100%-0.5rem)] w-px bg-line" aria-hidden />
      {activity.map((line, i) => (
        <li key={i} className="relative text-[12px]">
          <span className="absolute -left-4 top-1 h-2 w-2 rounded-full border-2 border-surface bg-accent" aria-hidden />
          <span className="text-fg-secondary">{line}</span>
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}

function NotesPanel({ sessionId }: { sessionId: string }) {
  const key = `rs-notes:${sessionId}`;
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    try {
      setValue(localStorage.getItem(key) || "");
    } catch {
      /* ignore */
    }
  }, [key]);
  const save = (v: string) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
      setSaved(true);
      setTimeout(() => setSaved(false), 1000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="space-y-2">
      <Field label="Session notes" htmlFor="notes">
        <Textarea
          id="notes"
          value={value}
          onChange={(e) => save(e.target.value)}
          placeholder="Jot down what you did, findings, follow-ups…"
          className="min-h-[240px]"
        />
      </Field>
      <p className="text-[11px] text-fg-muted">
        {saved ? "Saved locally." : "Saved to this browser."} Server-synced notes
        are a backend TODO.
      </p>
    </div>
  );
}
