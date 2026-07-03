// Typed WebSocket signaling envelope send/recv, per docs/API.md §Signaling.
//
// The console connects to `GET /ws/signal?session_id=...&token=...`.
// Both sockets exchange newline-free JSON envelopes:
//
//   { "type": "offer|answer|ice-candidate|session-control|banner|error",
//     "session_id": "...", "payload": { } }

import { WS_BASE_URL } from "./api";

export type SignalType =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "session-control"
  | "banner"
  | "error";

export type SessionControlAction = "start" | "end" | "approve";

export interface OfferPayload {
  type: "offer";
  sdp: string;
}

export interface AnswerPayload {
  type: "answer";
  sdp: string;
}

export interface SessionControlPayload {
  action: SessionControlAction;
}

export interface BannerPayload {
  visible: boolean;
}

export interface ErrorPayload {
  code?: string;
  message: string;
}

// Envelope is generic over its payload; concrete payloads are narrowed by
// `type` at the call site (see webrtc.ts).
export interface SignalEnvelope<P = unknown> {
  type: SignalType;
  session_id: string;
  payload: P;
}

export type OfferEnvelope = SignalEnvelope<OfferPayload> & { type: "offer" };
export type AnswerEnvelope = SignalEnvelope<AnswerPayload> & { type: "answer" };
export type IceEnvelope = SignalEnvelope<RTCIceCandidateInit> & {
  type: "ice-candidate";
};
export type SessionControlEnvelope = SignalEnvelope<SessionControlPayload> & {
  type: "session-control";
};
export type BannerEnvelope = SignalEnvelope<BannerPayload> & { type: "banner" };
export type ErrorEnvelope = SignalEnvelope<ErrorPayload> & { type: "error" };

export type AnySignalEnvelope =
  | OfferEnvelope
  | AnswerEnvelope
  | IceEnvelope
  | SessionControlEnvelope
  | BannerEnvelope
  | ErrorEnvelope;

export function buildSignalUrl(sessionId: string, token: string): string {
  const url = new URL("/ws/signal", WS_BASE_URL);
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("token", token);
  return url.toString();
}

// Parse an incoming raw WS message into a typed envelope. Returns null when the
// message is not a well-formed envelope.
export function parseEnvelope(raw: string): AnySignalEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const maybe = value as {
    type?: unknown;
    session_id?: unknown;
    payload?: unknown;
  };
  if (typeof maybe.type !== "string") return null;
  if (typeof maybe.session_id !== "string") return null;

  // The server guarantees payload shape per type; we trust the type tag here
  // and let the consumer narrow. This cast is the single controlled boundary
  // where wire data enters the typed world.
  return value as AnySignalEnvelope;
}

// Serialize a typed envelope for sending over the socket.
export function serializeEnvelope<P>(envelope: SignalEnvelope<P>): string {
  return JSON.stringify(envelope);
}
