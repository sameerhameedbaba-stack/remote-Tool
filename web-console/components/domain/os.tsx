"use client";

import { Monitor } from "lucide-react";
import type { DeviceOS } from "@/lib/api";
import { cn } from "@/lib/cn";

export function osLabel(os: DeviceOS): string {
  switch (os) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return os ? os.charAt(0).toUpperCase() + os.slice(1) : "Unknown";
  }
}

// Monochrome OS glyphs (currentColor) so they inherit token colors and stay
// crisp at small sizes — cleaner than a heavy brand-icon dependency.
export function OsIcon({ os, className }: { os: DeviceOS; className?: string }) {
  const c = cn("h-4 w-4", className);
  if (os === "windows") {
    return (
      <svg viewBox="0 0 24 24" className={c} fill="currentColor" aria-hidden>
        <path d="M3 5.7 10.4 4.7v6.6H3V5.7zM10.4 12.7v6.6L3 18.3v-5.6h7.4zM11.6 4.5 21 3.2v8.1h-9.4V4.5zM21 12.7v8.1l-9.4-1.3v-6.8H21z" />
      </svg>
    );
  }
  if (os === "macos") {
    return (
      <svg viewBox="0 0 24 24" className={c} fill="currentColor" aria-hidden>
        <path d="M16.4 12.7c0-2.2 1.8-3.3 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.8-3.6 2.1-1.5 2.7-.4 6.6 1.1 8.8.7 1 1.5 2.2 2.6 2.2 1 0 1.4-.7 2.7-.7s1.6.7 2.7.7 1.8-1 2.5-2c.8-1.1 1.1-2.2 1.1-2.3-.1 0-2.1-.8-2.1-3.1zM14.3 6.1c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2z" />
      </svg>
    );
  }
  if (os === "linux") {
    return (
      <svg viewBox="0 0 24 24" className={c} fill="currentColor" aria-hidden>
        <path d="M12 2c-2 0-3.2 1.6-3.2 3.9 0 1.5.6 2.4.6 3.6 0 1-1.2 2-2.1 3.6C6.3 14.9 5 17 5 18.6c0 1.4 1 1.9 2.3 2.2.5.1.8.5 1.3.7.6.3 1.4.5 3.4.5s2.8-.2 3.4-.5c.5-.2.8-.6 1.3-.7 1.3-.3 2.3-.8 2.3-2.2 0-1.6-1.3-3.7-2.3-5.5-.9-1.6-2.1-2.6-2.1-3.6 0-1.2.6-2.1.6-3.6C15.2 3.6 14 2 12 2zm-1.5 4.1c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm3 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zM12 9.3c.9 0 1.9.4 1.9.9 0 .3-.4.5-.9.8-.4.2-.7.5-1 .5s-.6-.3-1-.5c-.5-.3-.9-.5-.9-.8 0-.5 1-.9 1.9-.9z" />
      </svg>
    );
  }
  return <Monitor className={c} aria-hidden />;
}
