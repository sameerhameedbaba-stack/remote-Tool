"use client";

import { useEffect, useRef, useState } from "react";
import {
  MousePointer2,
  MousePointerBan,
  ClipboardCopy,
  FolderSync,
  MessageSquare,
  Maximize2,
  Scan,
  Monitor,
  Camera,
  RefreshCw,
  MoreHorizontal,
  Video,
  Lock,
  Command,
  Settings,
  PhoneOff,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { IconButton, Tooltip } from "@/components/ui";
import type { PanelTab } from "@/components/session/SessionRightPanel";
import { cn } from "@/lib/cn";

export interface ToolbarProps {
  connected: boolean;
  inputEnabled: boolean;
  onToggleInput: () => void;
  onClipboard: () => void;
  onOpenPanel: (tab: PanelTab) => void;
  onFullscreen: () => void;
  onFit: () => void;
  onReconnect: () => void;
  onEnd: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  recording: boolean;
  onToggleRecording: () => void;
  screenLocked: boolean;
  onToggleLock: () => void;
  inputDisabledRemote: boolean;
  onToggleInputDisabled: () => void;
  onPlaceholder: (label: string) => void;
}

function Sep() {
  return <span className="mx-1 h-6 w-px bg-line" aria-hidden />;
}

export function SessionToolbar(props: ToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const disabled = !props.connected;

  return (
    <div className="flex items-center gap-1 rounded-xl border border-line bg-surface/95 px-1.5 py-1.5 shadow-pop backdrop-blur">
      {/* Control group */}
      <Tooltip label={props.inputEnabled ? "Disable input control" : "Enable input control"} shortcut="⌥I">
        <IconButton
          label="Toggle input control"
          variant="toolbar"
          active={props.inputEnabled}
          disabled={disabled}
          onClick={props.onToggleInput}
        >
          {props.inputEnabled ? (
            <MousePointer2 className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <MousePointerBan className="h-[18px] w-[18px]" aria-hidden />
          )}
        </IconButton>
      </Tooltip>
      <Tooltip label="Sync clipboard to remote">
        <IconButton label="Sync clipboard" variant="toolbar" disabled={disabled} onClick={props.onClipboard}>
          <ClipboardCopy className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="File transfer">
        <IconButton label="File transfer" variant="toolbar" onClick={() => props.onOpenPanel("files")}>
          <FolderSync className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Chat">
        <IconButton label="Chat" variant="toolbar" onClick={() => props.onOpenPanel("chat")}>
          <MessageSquare className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>

      <Sep />

      {/* View group */}
      <Tooltip label="Fullscreen" shortcut="F">
        <IconButton label="Fullscreen" variant="toolbar" onClick={props.onFullscreen}>
          <Maximize2 className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Fit to screen">
        <IconButton label="Fit to screen" variant="toolbar" onClick={props.onFit}>
          <Scan className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Switch monitor (coming soon)">
        <IconButton
          label="Switch monitor"
          variant="toolbar"
          onClick={() => props.onPlaceholder("Multi-monitor switching")}
        >
          <Monitor className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Screenshot (coming soon)">
        <IconButton
          label="Screenshot"
          variant="toolbar"
          onClick={() => props.onPlaceholder("Screenshot capture")}
        >
          <Camera className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Reconnect">
        <IconButton label="Reconnect" variant="toolbar" onClick={props.onReconnect}>
          <RefreshCw className="h-[18px] w-[18px]" aria-hidden />
        </IconButton>
      </Tooltip>

      <Sep />

      {/* More (advanced / policy actions) */}
      <div ref={moreRef} className="relative">
        <Tooltip label="More actions">
          <IconButton
            label="More actions"
            variant="toolbar"
            active={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
          </IconButton>
        </Tooltip>
        {moreOpen && (
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-2 w-60 overflow-hidden rounded-xl border border-line bg-surface-raised p-1 shadow-pop animate-scale-in"
          >
            <MoreItem
              icon={<Video className="h-4 w-4" aria-hidden />}
              label={props.recording ? "Stop recording" : "Start recording"}
              tone={props.recording ? "danger" : undefined}
              onClick={() => {
                props.onToggleRecording();
                setMoreOpen(false);
              }}
            />
            <MoreItem
              icon={<Lock className="h-4 w-4" aria-hidden />}
              label={props.screenLocked ? "Unlock remote screen" : "Lock remote screen"}
              onClick={() => {
                props.onToggleLock();
                setMoreOpen(false);
              }}
            />
            <MoreItem
              icon={<MousePointerBan className="h-4 w-4" aria-hidden />}
              label={props.inputDisabledRemote ? "Allow remote input" : "Disable remote input"}
              onClick={() => {
                props.onToggleInputDisabled();
                setMoreOpen(false);
              }}
            />
            <MoreItem
              icon={<Command className="h-4 w-4" aria-hidden />}
              label="Send Ctrl+Alt+Del"
              onClick={() => {
                props.onPlaceholder("Ctrl+Alt+Del");
                setMoreOpen(false);
              }}
            />
            <div className="my-1 h-px bg-line" />
            <MoreItem
              icon={<Settings className="h-4 w-4" aria-hidden />}
              label="Session settings"
              onClick={() => {
                props.onOpenPanel("info");
                setMoreOpen(false);
              }}
            />
          </div>
        )}
      </div>

      <Tooltip label={props.panelOpen ? "Hide panel" : "Show panel"}>
        <IconButton label="Toggle side panel" variant="toolbar" active={props.panelOpen} onClick={props.onTogglePanel}>
          {props.panelOpen ? (
            <PanelRightClose className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <PanelRightOpen className="h-[18px] w-[18px]" aria-hidden />
          )}
        </IconButton>
      </Tooltip>

      <Sep />

      {/* Danger group — separated + confirmed */}
      <Tooltip label="End session" shortcut="⌥E">
        <button
          onClick={props.onEnd}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-danger px-3 text-[13px] font-semibold text-white transition-all hover:brightness-110"
        >
          <PhoneOff className="h-4 w-4" aria-hidden />
          End
        </button>
      </Tooltip>
    </div>
  );
}

function MoreItem({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-hover",
        tone === "danger" ? "text-danger" : "text-fg-secondary hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
