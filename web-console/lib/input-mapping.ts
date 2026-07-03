// Pure remote-input mapping helpers (no DOM/React dependencies) so they can be
// unit-tested in isolation. Used by the session page to translate browser
// pointer/keyboard events into the normalized protocol coordinates the agent
// expects.

import type { MouseButton } from "./webrtc";

// Map a DOM MouseEvent.button code to the protocol button name.
export function mouseButtonName(button: number): MouseButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

// Modifier state shared by React and DOM KeyboardEvents.
export interface ModifierState {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

// Collect active modifier keys as protocol modifier names.
export function modifiersFrom(e: ModifierState): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return mods;
}

export interface Size {
  width: number;
  height: number;
}

// A point relative to the top-left of the video element, in CSS pixels.
export interface Point {
  x: number;
  y: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// Translate a pointer position over the <video> element into a coordinate
// normalized to the ACTUAL streamed content, accounting for objectFit
// letterboxing ('contain') or cropping ('cover').
//
// `intrinsic` is the track's videoWidth/videoHeight. When it is unavailable
// (no frame yet) we fall back to naive element-box mapping. Returns null when
// the point falls in the letterbox bars (outside the real content), so those
// clicks can be dropped instead of mapped to bogus fractions.
export function normalizedCoords(
  point: Point,
  rect: Size,
  intrinsic: Size | null,
  fit: "contain" | "cover",
): NormalizedPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  // No intrinsic size yet: map against the raw element box.
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0) {
    const x = point.x / rect.width;
    const y = point.y / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: clamp01(x), y: clamp01(y) };
  }

  const videoAspect = intrinsic.width / intrinsic.height;
  const boxAspect = rect.width / rect.height;

  let contentW: number;
  let contentH: number;

  if (fit === "contain") {
    // Content is scaled to fit inside the box; the wider dimension fills.
    if (videoAspect > boxAspect) {
      contentW = rect.width;
      contentH = rect.width / videoAspect;
    } else {
      contentH = rect.height;
      contentW = rect.height * videoAspect;
    }
  } else {
    // cover: content is scaled to cover the box; the overflow is cropped.
    if (videoAspect > boxAspect) {
      contentH = rect.height;
      contentW = rect.height * videoAspect;
    } else {
      contentW = rect.width;
      contentH = rect.width / videoAspect;
    }
  }

  // Content is centered; offsets are positive for 'contain' (letterbox) and
  // negative for 'cover' (crop).
  const offsetX = (rect.width - contentW) / 2;
  const offsetY = (rect.height - contentH) / 2;

  const nx = (point.x - offsetX) / contentW;
  const ny = (point.y - offsetY) / contentH;

  // Drop clicks that land outside the real content area (the letterbox bars).
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;

  return { x: clamp01(nx), y: clamp01(ny) };
}
