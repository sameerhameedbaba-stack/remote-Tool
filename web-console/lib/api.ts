// Typed API client mirroring docs/API.md exactly.
//
// One function per endpoint. All request/response shapes conform to the
// authoritative contract in docs/API.md. Base URL comes from
// NEXT_PUBLIC_API_BASE_URL (non-secret, browser-exposed by definition).
//
// No `any` is used anywhere in this file.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const API_BASE_URL: string =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export const WS_BASE_URL: string =
  process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8080";

// ---------------------------------------------------------------------------
// Domain types (mirror docs/API.md)
// ---------------------------------------------------------------------------

export type TechnicianRole = "admin" | "technician";

export interface Technician {
  id: string;
  email: string;
  display_name: string;
  role: TechnicianRole;
}

export type DeviceOS = "windows" | "macos" | "linux" | string;
export type DeviceMode = "unattended" | "attended";
export type DeviceStatus = "online" | "offline";

export interface Device {
  id: string;
  name: string;
  hostname: string;
  os: DeviceOS;
  mode: DeviceMode;
  status: DeviceStatus;
  last_seen_at: string | null;
  created_at: string;
  // Returned by the backend on /devices and /devices/{id}.
  app_version?: string | null;
}

export type SessionType = "unattended" | "attended";
export type SessionStatus = "pending" | "active" | "ended";

export interface Session {
  id: string;
  device_id: string;
  technician_id: string;
  type: SessionType;
  status: SessionStatus;
  banner_visible?: boolean;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  // The backend now returns the relay/ICE servers on GET /sessions/{id} so a
  // reloaded session page can recover them without the sessionStorage stash.
  ice_servers?: IceServer[];
}

// RTCIceServer-compatible shape returned by the backend.
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type AuditEventType =
  | "auth.login"
  | "auth.login_failed"
  | "device.register"
  | "session.request"
  | "session.approve"
  | "session.start"
  | "session.end"
  | "file.transfer"
  | "clipboard.sync"
  | "input.command_attempt";

export interface AuditEvent {
  id: string;
  event_type: AuditEventType;
  session_id: string | null;
  technician_id: string | null;
  device_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  technician: Technician;
}

export interface DevicesResponse {
  devices: Device[];
}

export interface CreateSessionResponse {
  session: Session;
  ice_servers: IceServer[];
}

export interface AttendedCodeResponse {
  code: string;
  session_id: string;
  expires_at: string;
}

export interface SessionsResponse {
  sessions: Session[];
}

export interface AuditResponse {
  events: AuditEvent[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Error type thrown by the client on non-2xx responses
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// Narrow an unknown thrown value to a human-readable message, using the API
// error message when available and a caller-supplied fallback otherwise.
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// True when the thrown value is an ApiError produced by a failed fetch (the
// request never reached the server). Callers use this to ignore aborted /
// offline polling without surfacing a scary banner.
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "network_error";
}

// ---------------------------------------------------------------------------
// Low-level request helper
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string | null;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(
  path: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(path, API_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const maybe = value as { error?: unknown };
  if (typeof maybe.error !== "object" || maybe.error === null) return false;
  const err = maybe.error as { code?: unknown; message?: unknown };
  return typeof err.code === "string" && typeof err.message === "string";
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", token, body, query, signal } = options;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (cause) {
    throw new ApiError(
      0,
      "network_error",
      cause instanceof Error ? cause.message : "Network request failed",
    );
  }

  // 204 / empty body handling.
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    if (isErrorEnvelope(parsed)) {
      throw new ApiError(
        response.status,
        parsed.error.code,
        parsed.error.message,
      );
    }
    throw new ApiError(
      response.status,
      "internal",
      `Request failed with status ${response.status}`,
    );
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Endpoint functions — one per endpoint in docs/API.md
// ---------------------------------------------------------------------------

// --- Technician auth ---

export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export function getMe(token: string): Promise<Technician> {
  return request<Technician>("/api/v1/me", { token });
}

// --- Devices ---

export interface ListDevicesParams {
  status?: DeviceStatus;
  q?: string;
}

export function listDevices(
  token: string,
  params: ListDevicesParams = {},
  signal?: AbortSignal,
): Promise<DevicesResponse> {
  return request<DevicesResponse>("/api/v1/devices", {
    token,
    query: { status: params.status, q: params.q },
    signal,
  });
}

export function getDevice(token: string, id: string): Promise<Device> {
  return request<Device>(`/api/v1/devices/${encodeURIComponent(id)}`, {
    token,
  });
}

// --- Sessions ---

export function createSession(
  token: string,
  deviceId: string,
): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>("/api/v1/sessions", {
    method: "POST",
    token,
    body: { device_id: deviceId },
  });
}

export function createAttendedCode(
  token: string,
  label: string,
): Promise<AttendedCodeResponse> {
  return request<AttendedCodeResponse>("/api/v1/attended/codes", {
    method: "POST",
    token,
    body: { label },
  });
}

export interface ListSessionsParams {
  status?: SessionStatus;
  device_id?: string;
  limit?: number;
}

export function listSessions(
  token: string,
  params: ListSessionsParams = {},
  signal?: AbortSignal,
): Promise<SessionsResponse> {
  return request<SessionsResponse>("/api/v1/sessions", {
    token,
    query: {
      status: params.status,
      device_id: params.device_id,
      limit: params.limit,
    },
    signal,
  });
}

export function getSession(token: string, id: string): Promise<Session> {
  return request<Session>(`/api/v1/sessions/${encodeURIComponent(id)}`, {
    token,
  });
}

export function endSession(token: string, id: string): Promise<Session> {
  return request<Session>(
    `/api/v1/sessions/${encodeURIComponent(id)}/end`,
    { method: "POST", token },
  );
}

// --- Audit ---

export interface ListAuditParams {
  session_id?: string;
  device_id?: string;
  technician_id?: string;
  event_type?: AuditEventType;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export function listAudit(
  token: string,
  params: ListAuditParams = {},
  signal?: AbortSignal,
): Promise<AuditResponse> {
  return request<AuditResponse>("/api/v1/audit", {
    token,
    query: {
      session_id: params.session_id,
      device_id: params.device_id,
      technician_id: params.technician_id,
      event_type: params.event_type,
      since: params.since,
      until: params.until,
      limit: params.limit,
      cursor: params.cursor,
    },
    signal,
  });
}
