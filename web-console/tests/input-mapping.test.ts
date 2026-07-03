import { describe, it, expect } from "vitest";
import {
  mouseButtonName,
  modifiersFrom,
  normalizedCoords,
} from "@/lib/input-mapping";

describe("mouseButtonName", () => {
  it("maps button codes to protocol names", () => {
    expect(mouseButtonName(0)).toBe("left");
    expect(mouseButtonName(1)).toBe("middle");
    expect(mouseButtonName(2)).toBe("right");
    expect(mouseButtonName(3)).toBe("left"); // unknown -> left
  });
});

describe("modifiersFrom", () => {
  it("collects only active modifiers, in a stable order", () => {
    expect(
      modifiersFrom({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    ).toEqual(["ctrl", "shift"]);
    expect(
      modifiersFrom({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: true }),
    ).toEqual(["alt", "meta"]);
    expect(
      modifiersFrom({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }),
    ).toEqual([]);
  });
});

describe("normalizedCoords", () => {
  const box = { width: 200, height: 100 }; // aspect 2:1
  const square = { width: 100, height: 100 }; // aspect 1:1

  it("returns null for a zero-size element", () => {
    expect(
      normalizedCoords({ x: 5, y: 5 }, { width: 0, height: 100 }, square, "contain"),
    ).toBeNull();
  });

  it("maps naively (element box) when intrinsic size is unknown", () => {
    expect(normalizedCoords({ x: 100, y: 50 }, box, null, "contain")).toEqual({
      x: 0.5,
      y: 0.5,
    });
    // Outside the element box -> dropped.
    expect(normalizedCoords({ x: -1, y: 50 }, box, null, "contain")).toBeNull();
  });

  describe("contain (letterbox)", () => {
    // square video in a 2:1 box -> vertical bars, content is 100px wide,
    // centered with a 50px letterbox on each side.
    it("maps a click in the content area to the correct fraction", () => {
      expect(normalizedCoords({ x: 100, y: 50 }, box, square, "contain")).toEqual({
        x: 0.5,
        y: 0.5,
      });
      // Left edge of the real content (x=50 in element px) -> 0.
      expect(normalizedCoords({ x: 50, y: 0 }, box, square, "contain")).toEqual({
        x: 0,
        y: 0,
      });
      // Right edge of the real content (x=150) -> 1.
      expect(normalizedCoords({ x: 150, y: 100 }, box, square, "contain")).toEqual({
        x: 1,
        y: 1,
      });
    });

    it("drops clicks that land in the letterbox bars", () => {
      expect(normalizedCoords({ x: 10, y: 50 }, box, square, "contain")).toBeNull();
      expect(normalizedCoords({ x: 190, y: 50 }, box, square, "contain")).toBeNull();
    });
  });

  describe("cover (crop)", () => {
    // square video covering a 2:1 box -> content is 200x200, cropped
    // vertically (50px off top and bottom). No point maps outside.
    it("maps the center correctly", () => {
      expect(normalizedCoords({ x: 100, y: 50 }, box, square, "cover")).toEqual({
        x: 0.5,
        y: 0.5,
      });
    });

    it("keeps every in-box click inside the content", () => {
      const topLeft = normalizedCoords({ x: 0, y: 0 }, box, square, "cover");
      expect(topLeft).not.toBeNull();
      expect(topLeft!.x).toBeCloseTo(0);
      expect(topLeft!.y).toBeCloseTo(0.25);
    });
  });
});
