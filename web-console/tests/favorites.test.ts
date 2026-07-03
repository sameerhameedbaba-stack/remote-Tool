import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFavorites } from "@/lib/favorites";

describe("useFavorites", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("toggles favorites and persists them to localStorage", () => {
    const { result } = renderHook(() => useFavorites());

    expect(result.current.isFavorite("d1")).toBe(false);

    act(() => result.current.toggle("d1"));
    expect(result.current.isFavorite("d1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("rs-favorites")!)).toContain("d1");

    act(() => result.current.toggle("d1"));
    expect(result.current.isFavorite("d1")).toBe(false);
  });

  it("hydrates from existing localStorage state", () => {
    localStorage.setItem("rs-favorites", JSON.stringify(["seed"]));
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite("seed")).toBe(true);
  });

  it("survives corrupt localStorage without throwing", () => {
    localStorage.setItem("rs-favorites", "{not-json");
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite("anything")).toBe(false);
    // Still usable afterwards.
    act(() => result.current.toggle("x"));
    expect(result.current.isFavorite("x")).toBe(true);
  });
});
