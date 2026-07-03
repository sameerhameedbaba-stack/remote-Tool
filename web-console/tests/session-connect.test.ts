import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  iceStashKey,
  stashIceServers,
  loadStashedIceServers,
  clearStashedIceServers,
  startDeviceSession,
  PRESENCE_POLL_MS,
} from "@/lib/session-connect";
import type { IceServer } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createSession: vi.fn(),
  };
});

import { createSession } from "@/lib/api";

const servers: IceServer[] = [{ urls: "stun:stun.example:3478" }];

describe("ICE stash helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("keys the stash by session id", () => {
    expect(iceStashKey("abc")).toBe("rs_ice:abc");
  });

  it("round-trips servers through sessionStorage", () => {
    stashIceServers("s1", servers);
    expect(loadStashedIceServers("s1")).toEqual(servers);
  });

  it("returns [] when nothing is stashed", () => {
    expect(loadStashedIceServers("missing")).toEqual([]);
  });

  it("returns [] on corrupt stash data", () => {
    sessionStorage.setItem(iceStashKey("s2"), "{not json");
    expect(loadStashedIceServers("s2")).toEqual([]);
  });

  it("returns [] when the stashed value is not an array", () => {
    sessionStorage.setItem(iceStashKey("s3"), JSON.stringify({ nope: 1 }));
    expect(loadStashedIceServers("s3")).toEqual([]);
  });

  it("clears the stash", () => {
    stashIceServers("s4", servers);
    clearStashedIceServers("s4");
    expect(loadStashedIceServers("s4")).toEqual([]);
  });

  it("exposes the presence poll constant", () => {
    expect(PRESENCE_POLL_MS).toBe(10_000);
  });
});

describe("startDeviceSession", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(createSession).mockReset();
  });

  it("creates a session, stashes ICE servers, and returns the session", async () => {
    const session = {
      id: "sess-1",
      device_id: "dev-1",
      technician_id: "tech-1",
      type: "unattended" as const,
      status: "pending" as const,
      created_at: "2026-01-01T00:00:00Z",
    };
    vi.mocked(createSession).mockResolvedValue({ session, ice_servers: servers });

    const result = await startDeviceSession("token", "dev-1");

    expect(createSession).toHaveBeenCalledWith("token", "dev-1");
    expect(result).toEqual(session);
    expect(loadStashedIceServers("sess-1")).toEqual(servers);
  });
});
