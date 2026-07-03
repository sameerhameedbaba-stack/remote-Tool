import { describe, it, expect } from "vitest";
import {
  ApiError,
  errorMessage,
  isNetworkError,
  isErrorEnvelope,
} from "@/lib/api";

describe("errorMessage", () => {
  it("returns the ApiError message when given an ApiError", () => {
    const err = new ApiError(404, "not_found", "Device not found");
    expect(errorMessage(err, "fallback")).toBe("Device not found");
  });

  it("returns the fallback for non-ApiError values", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("fallback");
    expect(errorMessage("boom", "fallback")).toBe("fallback");
    expect(errorMessage(null, "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
  });
});

describe("isNetworkError", () => {
  it("is true only for ApiError with code network_error", () => {
    expect(isNetworkError(new ApiError(0, "network_error", "x"))).toBe(true);
  });

  it("is false for other ApiError codes and non-ApiErrors", () => {
    expect(isNetworkError(new ApiError(500, "internal", "x"))).toBe(false);
    expect(isNetworkError(new Error("network_error"))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError({ code: "network_error" })).toBe(false);
  });
});

describe("isErrorEnvelope", () => {
  it("accepts a well-formed error envelope", () => {
    expect(
      isErrorEnvelope({ error: { code: "bad", message: "nope" } }),
    ).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isErrorEnvelope(null)).toBe(false);
    expect(isErrorEnvelope({})).toBe(false);
    expect(isErrorEnvelope({ error: null })).toBe(false);
    expect(isErrorEnvelope({ error: { code: "bad" } })).toBe(false);
    expect(isErrorEnvelope({ error: { message: "nope" } })).toBe(false);
    expect(isErrorEnvelope({ error: { code: 1, message: "nope" } })).toBe(false);
    expect(isErrorEnvelope("error")).toBe(false);
  });
});
