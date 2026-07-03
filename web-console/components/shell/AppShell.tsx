"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";

// AppShell chooses the frame per route:
//  - unauthenticated or /login  → bare (the login screen owns the whole viewport)
//  - /sessions/[id]             → bare (the live session must dominate the screen)
//  - everything else            → sidebar + topbar + scrollable content
export function AppShell({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  const pathname = usePathname();

  const isLogin = pathname === "/login" || pathname === "/";
  const isSession = pathname.startsWith("/sessions/");

  // While auth is resolving on a protected route, avoid flashing chrome.
  if (isLogin || isSession || (!token && !loading)) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-app">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}
