// Shared "connect to a device" flow.
//
// The createSession -> stash ICE servers -> navigate sequence was copy-pasted
// (and had drifted) across the dashboard, devices, and command-palette. This
// module owns the ICE stash keying + the create-and-stash step so every call
// site behaves identically. Each site keeps its own error / navigation
// handling — this only covers the shared network + storage work.

import { createSession, type IceServer, type Session } from "./api";

// Presence polling cadence shared by the fleet views.
export const PRESENCE_POLL_MS = 10_000;

// sessionStorage key under which a session's ICE servers are stashed so the
// session page can pick them up after navigation without a second round-trip.
export function iceStashKey(sessionId: string): string {
  return `rs_ice:${sessionId}`;
}

export function stashIceServers(sessionId: string, servers: IceServer[]): void {
  try {
    sessionStorage.setItem(iceStashKey(sessionId), JSON.stringify(servers));
  } catch {
    /* ignore — private mode / quota */
  }
}

export function loadStashedIceServers(sessionId: string): IceServer[] {
  try {
    const raw = sessionStorage.getItem(iceStashKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IceServer[]) : [];
  } catch {
    return [];
  }
}

export function clearStashedIceServers(sessionId: string): void {
  try {
    sessionStorage.removeItem(iceStashKey(sessionId));
  } catch {
    /* ignore */
  }
}

// Create an unattended session for a device and stash its ICE servers so the
// session page can establish the peer connection. Returns the session; the
// caller owns navigation + error handling.
export async function startDeviceSession(
  token: string,
  deviceId: string,
): Promise<Session> {
  const res = await createSession(token, deviceId);
  stashIceServers(res.session.id, res.ice_servers);
  return res.session;
}
