import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { formatTime, timeAgo, useCountdown } from "@/components/ui/format";

describe("formatTime", () => {
  it("returns em-dash for null/undefined", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
  });

  it("returns the raw string for an unparseable date", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });

  it("formats a valid timestamp to a non-dash string", () => {
    const out = formatTime("2026-01-02T03:04:05Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("timeAgo", () => {
  it("returns 'never' for null/undefined", () => {
    expect(timeAgo(null)).toBe("never");
    expect(timeAgo(undefined)).toBe("never");
  });

  it("returns the raw string for an invalid date", () => {
    expect(timeAgo("nonsense")).toBe("nonsense");
  });

  it("reports 'just now' for the current instant", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
  });

  it("uses day granularity for old timestamps", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    expect(timeAgo(threeDaysAgo)).toBe("3d ago");
  });
});

describe("useCountdown", () => {
  it("reports expired with an em-dash label for null expiry", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current.expired).toBe(true);
    expect(result.current.label).toBe("—");
    expect(result.current.secondsLeft).toBe(0);
  });

  it("counts down for a future expiry", () => {
    const future = new Date(Date.now() + 90_000).toISOString();
    const { result } = renderHook(() => useCountdown(future));
    expect(result.current.expired).toBe(false);
    expect(result.current.secondsLeft).toBeGreaterThan(0);
    expect(result.current.label).toMatch(/^\d\d:\d\d$/);
  });

  it("reports expired for a past expiry", () => {
    const past = new Date(Date.now() - 5_000).toISOString();
    const { result } = renderHook(() => useCountdown(past));
    expect(result.current.expired).toBe(true);
    expect(result.current.secondsLeft).toBe(0);
  });
});
