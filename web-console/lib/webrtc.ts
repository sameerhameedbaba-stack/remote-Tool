// Remote-session WebRTC client.
//
// Encapsulates the RTCPeerConnection + signaling WebSocket glue + the three
// data channels (input / clipboard / file) with typed message senders that
// match the data-channel protocol in docs/API.md.
//
// The console is the ANSWERER: the agent (offerer) owns the screen media and
// creates the three data channels, then sends the SDP offer once its consent
// banner is visible. The console receives that offer, answers it, receives the
// data channels via `ondatachannel`, and surfaces the agent's video track via
// `onTrack` so the UI can attach it to a <video> element. The input/clipboard/
// file senders are real — they serialize protocol JSON and push it over the
// corresponding agent-created data channel.
//
// Connection ordering (POC): the console opens its signaling socket on mount
// and waits passively for the agent's offer. In the unattended flow the agent
// only offers after receiving `session-control:start` and acking the banner,
// so the console is connected first in practice. Production should have the
// backend buffer an offer for a not-yet-present peer (see docs/ROADMAP.md).

import {
  AnySignalEnvelope,
  BannerEnvelope,
  SessionControlEnvelope,
  SignalEnvelope,
  buildSignalUrl,
  parseEnvelope,
  serializeEnvelope,
} from "./signaling";
import type { IceServer } from "./api";

// --- Data-channel message types (peer-to-peer protocol) ---

export type MouseButton = "left" | "right" | "middle";
export type PointerAction = "down" | "up" | "move";

export interface MouseInputMessage {
  t: "mouse";
  x: number; // normalized [0,1] fraction of the streamed surface
  y: number;
  button?: MouseButton;
  action: PointerAction;
}

export interface KeyInputMessage {
  t: "key";
  code: string; // KeyboardEvent.code, e.g. "KeyA"
  action: "down" | "up";
  modifiers: string[]; // e.g. ["ctrl", "shift"]
}

export type InputMessage = MouseInputMessage | KeyInputMessage;

export type ClipboardDirection = "to-agent" | "to-tech";

export interface ClipboardMessage {
  t: "clipboard";
  direction: ClipboardDirection;
  text: string;
}

export type FileDirection = "to-agent" | "to-tech";

export interface FileOfferMessage {
  t: "file-offer";
  id: string;
  name: string;
  size: number;
  direction: FileDirection;
}
export interface FileAcceptMessage {
  t: "file-accept";
  id: string;
}
export interface FileChunkMessage {
  t: "file-chunk";
  id: string;
  seq: number;
  data: string; // base64
}
export interface FileCompleteMessage {
  t: "file-complete";
  id: string;
}

export type FileMessage =
  | FileOfferMessage
  | FileAcceptMessage
  | FileChunkMessage
  | FileCompleteMessage;

// --- Client status + callbacks ---

export type SessionConnectionState =
  | "idle"
  | "signaling"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "failed";

export interface RemoteSessionCallbacks {
  onTrack?: (stream: MediaStream) => void;
  /** A decoded screen frame from the agent's `screen` data channel. */
  onScreenFrame?: (bitmap: ImageBitmap, width: number, height: number) => void;
  onState?: (state: SessionConnectionState) => void;
  onClipboard?: (message: ClipboardMessage) => void;
  onFile?: (message: FileMessage) => void;
  onSessionControl?: (envelope: SessionControlEnvelope) => void;
  onBanner?: (envelope: BannerEnvelope) => void;
  onError?: (message: string) => void;
  onLog?: (line: string) => void;
}

// Wire format of each `screen` channel chunk (little-endian), matching the Rust
// agent's `encode` module: frame_id u32 | index u16 | count u16 | w u16 | h u16
// | jpeg bytes.
const SCREEN_HEADER_LEN = 12;

export interface RemoteSessionOptions {
  sessionId: string;
  token: string;
  iceServers: IceServer[];
  callbacks: RemoteSessionCallbacks;
}

const FILE_CHUNK_SIZE = 16 * 1024; // 16 KiB per chunk

export class RemoteSessionClient {
  private readonly sessionId: string;
  private readonly token: string;
  private readonly iceServers: IceServer[];
  private readonly cb: RemoteSessionCallbacks;

  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;

  private inputChannel: RTCDataChannel | null = null;
  private clipboardChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  private screenChannel: RTCDataChannel | null = null;

  // Screen-frame reassembly: buffer the chunks of the in-progress frame.
  private screenFrameId: number | null = null;
  private screenChunks: (Uint8Array | undefined)[] = [];
  private screenChunkCount = 0;
  private screenReceived = 0;
  private screenDims: { w: number; h: number } = { w: 0, h: 0 };
  private screenDecoding = false;

  private remoteStream: MediaStream | null = null;
  private closed = false;

  // ICE can arrive before the remote description is set; buffer until then.
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(options: RemoteSessionOptions) {
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.iceServers = options.iceServers;
    this.cb = options.callbacks;
  }

  // Establish signaling WS and build the peer connection, then wait for the
  // agent's offer (the console is the answerer).
  start(): void {
    this.setState("signaling");
    this.buildPeerConnection();
    this.connectSignaling();
  }

  private log(line: string): void {
    this.cb.onLog?.(line);
  }

  private setState(state: SessionConnectionState): void {
    this.cb.onState?.(state);
  }

  // --- Peer connection setup ---

  private buildPeerConnection(): void {
    const rtcIceServers: RTCIceServer[] = this.iceServers.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }));

    const pc = new RTCPeerConnection({ iceServers: rtcIceServers });
    this.pc = pc;

    this.remoteStream = new MediaStream();

    // Answerer: the agent creates the data channels; capture them by label.
    pc.ondatachannel = (event: RTCDataChannelEvent) => {
      const dc = event.channel;
      switch (dc.label) {
        case "input":
          this.inputChannel = dc;
          break;
        case "clipboard":
          this.clipboardChannel = dc;
          this.wireClipboardChannel();
          break;
        case "file":
          this.fileChannel = dc;
          this.wireFileChannel();
          break;
        case "screen":
          this.screenChannel = dc;
          this.wireScreenChannel();
          break;
        default:
          this.log(`ignoring unknown data channel: ${dc.label}`);
      }
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      const stream = this.remoteStream ?? new MediaStream();
      this.remoteStream = stream;
      stream.addTrack(event.track);
      this.log(`remote track received: ${event.track.kind}`);
      this.cb.onTrack?.(stream);
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        this.sendEnvelope({
          type: "ice-candidate",
          session_id: this.sessionId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.log(`connection state: ${state}`);
      if (state === "connected") this.setState("connected");
      else if (state === "connecting") this.setState("connecting");
      else if (state === "disconnected") this.setState("reconnecting");
      else if (state === "failed") this.setState("failed");
      else if (state === "closed") this.setState("closed");
    };
  }

  private wireClipboardChannel(): void {
    if (!this.clipboardChannel) return;
    this.clipboardChannel.onmessage = (event: MessageEvent<string>) => {
      const msg = safeParse<ClipboardMessage>(event.data);
      if (msg && msg.t === "clipboard") {
        this.cb.onClipboard?.(msg);
      }
    };
  }

  private wireFileChannel(): void {
    if (!this.fileChannel) return;
    this.fileChannel.onmessage = (event: MessageEvent<string>) => {
      const msg = safeParse<FileMessage>(event.data);
      if (msg && typeof msg.t === "string" && msg.t.startsWith("file-")) {
        this.cb.onFile?.(msg);
      }
    };
  }

  // Reassembles JPEG frames from the agent's `screen` channel and decodes them
  // to ImageBitmaps for a canvas. Binary chunks carry a 12-byte header; a new
  // frame_id discards any incomplete previous frame (we only ever show the
  // latest complete frame — stale partials are dropped, never rendered).
  private wireScreenChannel(): void {
    const dc = this.screenChannel;
    if (!dc) return;
    dc.binaryType = "arraybuffer";
    this.log("screen channel open; awaiting frames");
    dc.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const buf = new Uint8Array(event.data);
      if (buf.byteLength < SCREEN_HEADER_LEN) return;
      const view = new DataView(event.data);
      const frameId = view.getUint32(0, true);
      const index = view.getUint16(4, true);
      const count = view.getUint16(6, true);
      const width = view.getUint16(8, true);
      const height = view.getUint16(10, true);
      if (count === 0 || index >= count) return;

      // Starting a new frame: reset the assembler.
      if (this.screenFrameId !== frameId) {
        this.screenFrameId = frameId;
        this.screenChunkCount = count;
        this.screenChunks = new Array(count).fill(undefined);
        this.screenReceived = 0;
        this.screenDims = { w: width, h: height };
      }
      if (this.screenChunks[index] === undefined) {
        this.screenChunks[index] = buf.subarray(SCREEN_HEADER_LEN);
        this.screenReceived += 1;
      }
      if (this.screenReceived === this.screenChunkCount) {
        this.decodeScreenFrame();
      }
    };
  }

  private decodeScreenFrame(): void {
    // Coalesce: if a decode is already in flight, skip — a fresher frame will
    // arrive shortly (this is a live stream, not a reliable delivery).
    if (this.screenDecoding) return;
    const parts = this.screenChunks;
    const { w, h } = this.screenDims;
    if (parts.some((p) => p === undefined)) return;
    const total = parts.reduce((n, p) => n + (p?.byteLength ?? 0), 0);
    const jpeg = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      if (p) {
        jpeg.set(p, off);
        off += p.byteLength;
      }
    }
    this.screenDecoding = true;
    const blob = new Blob([jpeg], { type: "image/jpeg" });
    createImageBitmap(blob)
      .then((bitmap) => {
        this.screenDecoding = false;
        if (this.closed) {
          bitmap.close();
          return;
        }
        this.cb.onScreenFrame?.(bitmap, w, h);
      })
      .catch((err) => {
        this.screenDecoding = false;
        this.log(`screen frame decode failed: ${String(err)}`);
      });
  }

  // --- Signaling ---

  private connectSignaling(): void {
    const ws = new WebSocket(buildSignalUrl(this.sessionId, this.token));
    this.ws = ws;

    ws.onopen = () => {
      this.log("signaling socket open; awaiting agent offer");
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      const envelope = parseEnvelope(event.data);
      if (envelope) void this.handleEnvelope(envelope);
    };

    ws.onerror = () => {
      this.cb.onError?.("Signaling socket error");
    };

    ws.onclose = () => {
      this.log("signaling socket closed");
    };
  }

  private async answerOffer(sdp: string): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp });
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendEnvelope({
        type: "answer",
        session_id: this.sessionId,
        payload: { type: "answer", sdp: answer.sdp ?? "" },
      });
      this.log("answer sent");
    } catch (err) {
      this.cb.onError?.(
        err instanceof Error ? err.message : "Failed to answer offer",
      );
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        this.log(
          `failed to add buffered ICE candidate: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
      }
    }
  }

  private async handleEnvelope(envelope: AnySignalEnvelope): Promise<void> {
    if (!this.pc) return;
    switch (envelope.type) {
      case "offer": {
        await this.answerOffer(envelope.payload.sdp);
        break;
      }
      case "ice-candidate": {
        // Buffer until the remote description exists, else addIceCandidate throws.
        if (!this.remoteDescriptionSet) {
          this.pendingCandidates.push(envelope.payload);
          break;
        }
        try {
          await this.pc.addIceCandidate(envelope.payload);
        } catch (err) {
          this.log(
            `failed to add ICE candidate: ${
              err instanceof Error ? err.message : "unknown"
            }`,
          );
        }
        break;
      }
      case "session-control": {
        this.cb.onSessionControl?.(envelope);
        if (envelope.payload.action === "end") {
          this.close();
        }
        break;
      }
      case "banner": {
        this.cb.onBanner?.(envelope);
        break;
      }
      case "error": {
        this.cb.onError?.(envelope.payload.message);
        break;
      }
      case "answer": {
        // The console is the answerer; a peer answer is unexpected. Ignore.
        this.log("unexpected answer envelope ignored");
        break;
      }
    }
  }

  private sendEnvelope<P>(envelope: SignalEnvelope<P>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeEnvelope(envelope));
    }
  }

  // --- Typed data-channel senders ---

  sendInput(message: InputMessage): boolean {
    return sendJson(this.inputChannel, message);
  }

  sendClipboard(text: string): boolean {
    const message: ClipboardMessage = {
      t: "clipboard",
      direction: "to-agent",
      text,
    };
    return sendJson(this.clipboardChannel, message);
  }

  // Send a file over the `file` channel using the chunked protocol. Returns a
  // promise that resolves once all chunks + the completion marker are queued.
  async sendFile(file: File): Promise<void> {
    if (!this.fileChannel || this.fileChannel.readyState !== "open") {
      throw new Error("File channel is not open");
    }
    const id = cryptoRandomId();
    const offer: FileOfferMessage = {
      t: "file-offer",
      id,
      name: file.name,
      size: file.size,
      direction: "to-agent",
    };
    sendJson(this.fileChannel, offer);

    const buffer = new Uint8Array(await file.arrayBuffer());
    let seq = 0;
    for (let offset = 0; offset < buffer.length; offset += FILE_CHUNK_SIZE) {
      const slice = buffer.subarray(offset, offset + FILE_CHUNK_SIZE);
      const chunk: FileChunkMessage = {
        t: "file-chunk",
        id,
        seq,
        data: base64FromBytes(slice),
      };
      sendJson(this.fileChannel, chunk);
      seq += 1;
    }

    const complete: FileCompleteMessage = { t: "file-complete", id };
    sendJson(this.fileChannel, complete);
    this.log(`file sent: ${file.name} (${file.size} bytes, ${seq} chunks)`);
  }

  // --- Teardown ---

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inputChannel?.close();
      this.clipboardChannel?.close();
      this.fileChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.remoteStream?.getTracks().forEach((t) => t.stop());
    this.setState("closed");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(channel: RTCDataChannel | null, value: unknown): boolean {
  if (!channel || channel.readyState !== "open") return false;
  channel.send(JSON.stringify(value));
  return true;
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa !== "undefined") {
    return btoa(binary);
  }
  // Node fallback (build-time safety; runtime is the browser).
  return Buffer.from(binary, "binary").toString("base64");
}
