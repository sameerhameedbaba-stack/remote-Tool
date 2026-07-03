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
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  ApiError,
  endSession,
  getSession,
  type IceServer,
  type Session,
} from "@/lib/api";
import {
  RemoteSessionClient,
  type ClipboardMessage,
  type FileMessage,
  type InputMessage,
  type MouseButton,
  type PointerAction,
  type SessionConnectionState,
} from "@/lib/webrtc";
import { SessionBadge } from "@/components/ui";

// Map a DOM mouse button number to the protocol button name.
function mouseButtonName(button: number): MouseButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

// Translate a browser modifier set into the protocol's lowercase names.
function modifiersFrom(e: ReactKeyboardEvent | KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return mods;
}

function loadStashedIceServers(sessionId: string): IceServer[] {
  try {
    const raw = sessionStorage.getItem(`rs_ice:${sessionId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as IceServer[];
    return [];
  } catch {
    return [];
  }
}

const CONNECTION_LABEL: Record<SessionConnectionState, string> = {
  idle: "Idle",
  signaling: "Signaling…",
  connecting: "Connecting…",
  connected: "Connected",
  closed: "Closed",
  failed: "Connection failed",
};

function SessionContent() {
  const { token } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;

  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<RemoteSessionClient | null>(null);
  const inputEnabledRef = useRef(false);

  const [session, setSession] = useState<Session | null>(null);
  const [connState, setConnState] = useState<SessionConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);

  const [inputEnabled, setInputEnabled] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [clipboardIn, setClipboardIn] = useState<string>("");

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [
      ...prev.slice(-40),
      `${new Date().toLocaleTimeString()}  ${line}`,
    ]);
  }, []);

  // Establish the session once we have a token + session id.
  useEffect(() => {
    if (!token || !sessionId) return;
    let disposed = false;

    void getSession(token, sessionId)
      .then((s) => {
        if (!disposed) setSession(s);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(
            err instanceof ApiError ? err.message : "Failed to load session",
          );
        }
      });

    const iceServers = loadStashedIceServers(sessionId);
    if (iceServers.length === 0) {
      appendLog(
        "No ICE servers were stashed for this session; using host candidates only.",
      );
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
            appendLog(`clipboard received (${msg.text.length} chars)`);
          }
        },
        onFile: (msg: FileMessage) => {
          appendLog(`file channel: ${msg.t}`);
        },
        onSessionControl: (env) => {
          appendLog(`session-control: ${env.payload.action}`);
          if (env.payload.action === "end") setEnded(true);
        },
        onBanner: (env) => {
          appendLog(`agent banner visible: ${env.payload.visible}`);
        },
        onError: (message) => {
          setError(message);
          appendLog(`error: ${message}`);
        },
        onLog: (line) => appendLog(line),
      },
    });
    clientRef.current = client;
    client.start();

    return () => {
      disposed = true;
      client.close();
      clientRef.current = null;
    };
  }, [token, sessionId, appendLog]);

  useEffect(() => {
    inputEnabledRef.current = inputEnabled;
  }, [inputEnabled]);

  const sendInput = useCallback((message: InputMessage) => {
    clientRef.current?.sendInput(message);
  }, []);

  // --- Mouse capture over the video surface ---

  const normalizedCoords = (
    e: ReactMouseEvent<HTMLVideoElement>,
  ): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  };

  const onMouse = (
    e: ReactMouseEvent<HTMLVideoElement>,
    action: PointerAction,
  ) => {
    if (!inputEnabledRef.current) return;
    const { x, y } = normalizedCoords(e);
    sendInput({
      t: "mouse",
      x,
      y,
      action,
      button: action === "move" ? undefined : mouseButtonName(e.button),
    });
  };

  const onKey = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    action: "down" | "up",
  ) => {
    if (!inputEnabledRef.current) return;
    // Prevent the browser from acting on control input while capturing.
    e.preventDefault();
    sendInput({
      t: "key",
      code: e.code,
      action,
      modifiers: modifiersFrom(e),
    });
  };

  // --- Clipboard sync ---

  const onSyncClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const ok = clientRef.current?.sendClipboard(text);
      appendLog(ok ? "clipboard sent to agent" : "clipboard channel not open");
    } catch {
      appendLog("clipboard read blocked by the browser");
      setError("Unable to read the local clipboard (permission denied).");
    }
  };

  // --- File send ---

  const fileInputRef = useRef<HTMLInputElement>(null);
  const onFileSelected = async (file: File | undefined) => {
    if (!file) return;
    try {
      await clientRef.current?.sendFile(file);
      appendLog(`file queued: ${file.name}`);
    } catch (err) {
      appendLog(
        `file send failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
      setError("File channel is not open yet.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // --- End session ---

  const onEndSession = async () => {
    if (!token) return;
    setEnding(true);
    setError(null);
    try {
      const updated = await endSession(token, sessionId);
      setSession(updated);
      setEnded(true);
      clientRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to end session");
    } finally {
      setEnding(false);
    }
  };

  const isLive = !ended && session?.status !== "ended";

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      {/* MANDATORY non-dismissible active-session indicator.
          Mirrors the agent-side banner requirement: the technician UI must make
          a live remote session unmistakable. */}
      <div
        role="status"
        aria-live="polite"
        className={`flex items-center justify-center gap-3 px-4 py-2 text-sm font-semibold ${
          isLive
            ? "bg-red-600 text-white"
            : "bg-surface-700 text-slate-300"
        }`}
      >
        <span
          aria-hidden
          className={`h-2.5 w-2.5 rounded-full ${
            isLive ? "animate-pulse bg-white" : "bg-slate-400"
          }`}
        />
        {isLive
          ? "REMOTE SESSION ACTIVE — you are viewing and controlling a remote machine"
          : "Session ended — the remote connection is closed"}
      </div>

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">
              Session{" "}
              <span className="font-mono text-slate-400">
                {sessionId.slice(0, 8)}
              </span>
            </h1>
            <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
              {session && <SessionBadge status={session.status} />}
              <span>{CONNECTION_LABEL[connState]}</span>
              {session && <span>· {session.type}</span>}
            </div>
          </div>
          <button
            onClick={onEndSession}
            className="btn-danger"
            disabled={ending || ended}
          >
            {ending ? "Ending…" : "End session"}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
          {/* Video surface + input capture */}
          <div>
            <div
              tabIndex={0}
              role="application"
              aria-label="Remote screen. Enable input control to send mouse and keyboard."
              onKeyDown={(e) => onKey(e, "down")}
              onKeyUp={(e) => onKey(e, "up")}
              className="relative overflow-hidden rounded-lg border border-surface-700 bg-black outline-none"
            >
              <video
                ref={videoRef}
                className="aspect-video w-full bg-black"
                autoPlay
                playsInline
                muted
                onContextMenu={(e) => e.preventDefault()}
                onMouseDown={(e) => onMouse(e, "down")}
                onMouseUp={(e) => onMouse(e, "up")}
                onMouseMove={(e) => onMouse(e, "move")}
              />
              {connState !== "connected" && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-slate-300">
                  {CONNECTION_LABEL[connState]} — waiting for the agent&apos;s
                  screen…
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent-500"
                  checked={inputEnabled}
                  onChange={(e) => setInputEnabled(e.target.checked)}
                />
                Enable input control (mouse + keyboard)
              </label>
              {inputEnabled && (
                <span className="text-xs text-amber-300">
                  Click the screen, then type to send keystrokes to the remote.
                </span>
              )}
            </div>
          </div>

          {/* Controls sidebar */}
          <aside className="space-y-4">
            <div className="card">
              <h2 className="text-sm font-semibold text-white">Clipboard</h2>
              <p className="mt-1 text-xs text-slate-500">
                Send your local clipboard to the remote machine.
              </p>
              <button
                onClick={onSyncClipboard}
                className="btn-secondary mt-3 w-full"
              >
                Sync clipboard to agent
              </button>
              {clipboardIn && (
                <div className="mt-3">
                  <div className="label">From remote</div>
                  <textarea
                    readOnly
                    className="input h-20 resize-none font-mono text-xs"
                    value={clipboardIn}
                  />
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-white">Send file</h2>
              <p className="mt-1 text-xs text-slate-500">
                Files are written to the agent&apos;s fixed downloads directory.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                onChange={(e) => void onFileSelected(e.target.files?.[0])}
                className="mt-3 block w-full text-xs text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-surface-700 file:px-3 file:py-2 file:text-sm file:text-slate-200 hover:file:bg-surface-600"
              />
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold text-white">Activity</h2>
              <div className="mt-2 h-48 overflow-y-auto rounded bg-surface-950 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
                {log.length === 0 ? (
                  <span className="text-slate-600">No activity yet…</span>
                ) : (
                  log.map((line, i) => <div key={i}>{line}</div>)
                )}
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-6">
          <button
            onClick={() => router.push("/devices")}
            className="text-sm text-slate-400 hover:text-slate-200 hover:underline"
          >
            ← Back to devices
          </button>
        </div>
      </div>
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
