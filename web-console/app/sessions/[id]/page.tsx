"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useRouter } from "next/navigation";
import { MonitorPlay } from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  endSession,
  getDevice,
  getSession,
  errorMessage,
  type Device,
  type IceServer,
  type Session,
} from "@/lib/api";
import {
  RemoteSessionClient,
  type ClipboardMessage,
  type FileMessage,
  type InputMessage,
  type PointerAction,
  type SessionConnectionState,
} from "@/lib/webrtc";
import {
  loadStashedIceServers,
  clearStashedIceServers,
} from "@/lib/session-connect";
import {
  mouseButtonName,
  modifiersFrom,
  normalizedCoords,
} from "@/lib/input-mapping";
import { ConfirmDialog } from "@/components/ui";
import { useElapsed } from "@/components/ui";
import { SessionTopBar } from "@/components/session/SessionTopBar";
import { SessionToolbar } from "@/components/session/SessionToolbar";
import {
  SessionRightPanel,
  type PanelTab,
  type FileItem,
} from "@/components/session/SessionRightPanel";
import { ConnectionOverlay } from "@/components/session/ConnectionOverlay";

function SessionContent() {
  const { token, technician } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RemoteSessionClient | null>(null);
  const inputEnabledRef = useRef(false);
  // Coalesce pointer-move sends to one per animation frame.
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [connState, setConnState] = useState<SessionConnectionState>("idle");
  // Errors are captured for logging/activity; the overlay drives what the user
  // sees, so the value itself isn't rendered directly.
  const [, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const [bannerAcked, setBannerAcked] = useState(false);

  const [inputEnabled, setInputEnabled] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [clipboardIn, setClipboardIn] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);

  // UI state
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("info");
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [recording, setRecording] = useState(false);
  const [screenLocked, setScreenLocked] = useState(false);
  const [inputDisabledRemote, setInputDisabledRemote] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Resolved once: stashed ICE servers, or (on reload) the ones GET returns.
  const [iceServers, setIceServers] = useState<IceServer[] | null>(null);

  const elapsed = useElapsed(session?.started_at ?? session?.created_at);

  const appendActivity = useCallback((line: string) => {
    setActivity((prev) => [
      ...prev.slice(-60),
      `${new Date().toLocaleTimeString()}  ${line}`,
    ]);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Load session + device metadata.
  useEffect(() => {
    if (!token || !sessionId) return;
    let disposed = false;
    void getSession(token, sessionId)
      .then((s) => {
        if (disposed) return;
        setSession(s);
        if (s.banner_visible) setBannerAcked(true);
        if (s.device_id) {
          void getDevice(token, s.device_id)
            .then((d) => !disposed && setDevice(d))
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) =>
        setError(errorMessage(err, "Failed to load session")),
      );
    return () => {
      disposed = true;
    };
  }, [token, sessionId]);

  // Resolve the ICE servers exactly once: prefer the stash written at connect
  // time, and fall back to the ice_servers the backend now returns on
  // GET /sessions/{id} (covers a direct load / page refresh).
  useEffect(() => {
    if (!sessionId || iceServers !== null) return;
    const stashed = loadStashedIceServers(sessionId);
    if (stashed.length > 0) {
      setIceServers(stashed);
      return;
    }
    if (session) setIceServers(session.ice_servers ?? []);
  }, [sessionId, session, iceServers]);

  // Establish (and re-establish on reconnect) the WebRTC client. Gated on ICE
  // resolution so the fallback source has a chance to load.
  useEffect(() => {
    if (!token || !sessionId || iceServers === null) return;
    if (iceServers.length === 0) {
      appendActivity("Using host ICE candidates (no relay available).");
    }
    const client = new RemoteSessionClient({
      sessionId,
      token,
      iceServers,
      callbacks: {
        onTrack: (stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            void videoRef.current.play().catch(() => undefined);
          }
        },
        onState: (state) => setConnState(state),
        onClipboard: (msg: ClipboardMessage) => {
          if (msg.direction === "to-tech") {
            setClipboardIn(msg.text);
            appendActivity(`Clipboard received (${msg.text.length} chars)`);
          }
        },
        onFile: (msg: FileMessage) => appendActivity(`File channel: ${msg.t}`),
        onSessionControl: (env) => {
          appendActivity(`Session control: ${env.payload.action}`);
          if (env.payload.action === "end") {
            setEnded(true);
            clearStashedIceServers(sessionId);
          }
        },
        onBanner: (env) => {
          setBannerAcked(!!env.payload.visible);
          appendActivity(`Consent banner acknowledged by user`);
        },
        onError: (message) => {
          setError(message);
          appendActivity(`Error: ${message}`);
        },
        onLog: (line) => appendActivity(line),
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [token, sessionId, iceServers, appendActivity, nonce]);

  useEffect(() => {
    inputEnabledRef.current = inputEnabled;
  }, [inputEnabled]);

  const sendInput = useCallback((message: InputMessage) => {
    clientRef.current?.sendInput(message);
  }, []);

  // Flush the most-recent coalesced pointer-move (rAF-throttled).
  const flushMove = useCallback(() => {
    moveRafRef.current = null;
    const p = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (p && inputEnabledRef.current) {
      sendInput({ t: "mouse", x: p.x, y: p.y, action: "move" });
    }
  }, [sendInput]);

  useEffect(() => {
    return () => {
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
    };
  }, []);

  const onMouse = (e: ReactMouseEvent<HTMLVideoElement>, action: PointerAction) => {
    if (!inputEnabledRef.current) return;
    const video = e.currentTarget;
    const rect = video.getBoundingClientRect();
    const intrinsic =
      video.videoWidth > 0 && video.videoHeight > 0
        ? { width: video.videoWidth, height: video.videoHeight }
        : null;
    const coords = normalizedCoords(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
      intrinsic,
      fit,
    );
    // Drop clicks in the letterbox / outside the real content area.
    if (!coords) return;

    if (action === "move") {
      // Coalesce: keep only the latest position, send once per frame.
      pendingMoveRef.current = coords;
      if (moveRafRef.current === null) {
        moveRafRef.current = requestAnimationFrame(flushMove);
      }
      return;
    }

    // Down/up are sent immediately (never throttled).
    sendInput({
      t: "mouse",
      x: coords.x,
      y: coords.y,
      action,
      button: mouseButtonName(e.button),
    });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, action: "down" | "up") => {
    if (!inputEnabledRef.current) return;
    e.preventDefault();
    sendInput({ t: "key", code: e.code, action, modifiers: modifiersFrom(e) });
  };

  const onSyncClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const ok = clientRef.current?.sendClipboard(text);
      appendActivity(ok ? "Clipboard sent to remote" : "Clipboard channel not open");
      if (!ok) showToast("Clipboard channel is not open yet.");
    } catch {
      showToast("Unable to read the local clipboard (permission denied).");
    }
  };

  const onSendFile = (file: File) => {
    const id = `${file.name}-${Date.now()}`;
    setFiles((prev) => [
      ...prev,
      { id, name: file.name, size: file.size, status: "sending", danger: false },
    ]);
    void clientRef.current
      ?.sendFile(file)
      .then(() => {
        setFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, status: "sent" } : f)),
        );
        appendActivity(`File sent: ${file.name}`);
      })
      .catch(() => {
        setFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, status: "failed" } : f)),
        );
        showToast("File channel is not open yet.");
      });
  };

  const doEndSession = async () => {
    if (!token) return;
    setEnding(true);
    setError(null);
    try {
      const updated = await endSession(token, sessionId);
      setSession(updated);
      setEnded(true);
      clientRef.current?.close();
      clearStashedIceServers(sessionId);
    } catch (err) {
      setError(errorMessage(err, "Failed to end session"));
    } finally {
      setEnding(false);
      setConfirmEnd(false);
    }
  };

  const onFullscreen = () => {
    const el = canvasWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => showToast("Fullscreen blocked."));
  };

  const onReconnect = () => {
    clientRef.current?.close();
    setEnded(false);
    setConnState("idle");
    appendActivity("Reconnecting…");
    setNonce((n) => n + 1);
  };

  const openPanel = (tab: PanelTab) => {
    setPanelTab(tab);
    setPanelOpen(true);
  };

  // Keyboard shortcuts (ignored while typing in fields).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && ["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setInputEnabled((v) => !v);
      } else if (e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setConfirmEnd(true);
      } else if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
        if (!inputEnabledRef.current) {
          e.preventDefault();
          onFullscreen();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionActive = !ended && session?.status !== "ended";
  const deviceName = device?.name || session?.device_id?.slice(0, 8) || "Remote device";
  const deviceOs = device?.os || "unknown";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app">
      <SessionTopBar
        session={session}
        sessionActive={!!sessionActive}
        deviceName={deviceName}
        deviceOs={deviceOs}
        connState={connState}
        elapsed={elapsed}
        technicianName={technician?.display_name || "Technician"}
        bannerAcked={bannerAcked}
        recording={recording}
        inputDisabledRemote={inputDisabledRemote}
        screenLocked={screenLocked}
        latencyMs={null}
      />

      <div className="flex min-h-0 flex-1">
        {/* Canvas + toolbar */}
        <div className="relative flex min-w-0 flex-1 flex-col bg-black">
          <div ref={canvasWrapRef} className="relative flex-1 overflow-hidden">
            <div
              tabIndex={0}
              role="application"
              aria-label="Remote screen. Enable input control to send mouse and keyboard."
              onKeyDown={(e) => onKey(e, "down")}
              onKeyUp={(e) => onKey(e, "up")}
              className="absolute inset-0 outline-none"
            >
              <video
                ref={videoRef}
                className="h-full w-full bg-black"
                style={{ objectFit: fit }}
                autoPlay
                playsInline
                muted
                onContextMenu={(e) => e.preventDefault()}
                onMouseDown={(e) => onMouse(e, "down")}
                onMouseUp={(e) => onMouse(e, "up")}
                onMouseMove={(e) => onMouse(e, "move")}
              />
            </div>

            <ConnectionOverlay
              connState={connState}
              ended={ended}
              bannerAcked={bannerAcked}
              onReconnect={onReconnect}
              onBack={() => router.push("/devices")}
            />

            {/* Idle-video hint when connected but no track yet. */}
            {connState === "connected" && (
              <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center text-fg-muted">
                <MonitorPlay className="h-8 w-8" aria-hidden />
                <p className="text-[13px]">
                  Connected — waiting for the agent&apos;s screen stream.
                </p>
              </div>
            )}

            {inputEnabled && (
              <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-accent-fg shadow-elev-2">
                Input control active — click the screen, then type
              </div>
            )}
          </div>

          {/* Floating toolbar */}
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
            <div className="pointer-events-auto">
              <SessionToolbar
                connected={connState === "connected"}
                inputEnabled={inputEnabled}
                onToggleInput={() => setInputEnabled((v) => !v)}
                onClipboard={() => void onSyncClipboard()}
                onOpenPanel={openPanel}
                onFullscreen={onFullscreen}
                onFit={() => setFit((f) => (f === "contain" ? "cover" : "contain"))}
                onReconnect={onReconnect}
                onEnd={() => setConfirmEnd(true)}
                panelOpen={panelOpen}
                onTogglePanel={() => setPanelOpen((o) => !o)}
                recording={recording}
                onToggleRecording={() => {
                  setRecording((r) => !r);
                  showToast(
                    recording ? "Recording stopped (preview)" : "Recording started (preview)",
                  );
                }}
                screenLocked={screenLocked}
                onToggleLock={() => {
                  setScreenLocked((s) => !s);
                  showToast("Remote screen lock is a preview control.");
                }}
                inputDisabledRemote={inputDisabledRemote}
                onToggleInputDisabled={() => {
                  setInputDisabledRemote((s) => !s);
                  showToast("Remote input lock is a preview control.");
                }}
                onPlaceholder={(label) => showToast(`${label} is coming soon.`)}
              />
            </div>
          </div>

          {toast && (
            <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-[13px] text-fg shadow-pop animate-fade-in">
              {toast}
            </div>
          )}
        </div>

        {/* Right panel */}
        {panelOpen && (
          <div className="hidden w-[340px] shrink-0 border-l border-line md:block">
            <SessionRightPanel
              tab={panelTab}
              onTab={setPanelTab}
              session={session}
              sessionId={sessionId}
              deviceName={deviceName}
              connState={connState}
              elapsed={elapsed}
              technicianName={technician?.display_name || "Technician"}
              latencyMs={null}
              bannerAcked={bannerAcked}
              activity={activity}
              clipboardIn={clipboardIn}
              onSyncClipboard={() => void onSyncClipboard()}
              onSendFile={onSendFile}
              files={files}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => void doEndSession()}
        title="End this session?"
        message="The remote connection will close immediately and both sides will be notified. This action is logged."
        confirmLabel="End session"
        tone="danger"
        loading={ending}
      />
    </div>
  );
}

export default function SessionPage() {
  return (
    <RequireAuth>
      <SessionContent />
    </RequireAuth>
  );
}
