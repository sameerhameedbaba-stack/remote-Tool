import { describe, it, expect } from "vitest";
import { parseEnvelope, serializeEnvelope } from "@/lib/signaling";

describe("parseEnvelope", () => {
  it("parses a well-formed envelope", () => {
    const raw = JSON.stringify({
      type: "offer",
      session_id: "s1",
      payload: { type: "offer", sdp: "v=0" },
    });
    const env = parseEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env?.type).toBe("offer");
    expect(env?.session_id).toBe("s1");
  });

  it("returns null on invalid JSON", () => {
    expect(parseEnvelope("{not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("returns null when not an object", () => {
    expect(parseEnvelope("42")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope('"a string"')).toBeNull();
  });

  it("returns null when required fields are missing or wrong-typed", () => {
    expect(parseEnvelope(JSON.stringify({ session_id: "s1", payload: {} }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ type: "offer", payload: {} }))).toBeNull();
    expect(
      parseEnvelope(JSON.stringify({ type: 5, session_id: "s1", payload: {} })),
    ).toBeNull();
    expect(
      parseEnvelope(JSON.stringify({ type: "offer", session_id: 5, payload: {} })),
    ).toBeNull();
  });

  it("round-trips with serializeEnvelope", () => {
    const env = {
      type: "banner" as const,
      session_id: "abc",
      payload: { visible: true },
    };
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed).toEqual(env);
  });
});
