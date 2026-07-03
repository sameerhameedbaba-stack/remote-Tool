"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

// Landing route: send authenticated technicians to the dashboard, everyone
// else to login. The route guard on protected pages does the real enforcement.
export default function IndexPage() {
  const { token, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(token ? "/dashboard" : "/login");
  }, [token, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-app text-fg-muted">
      <span className="animate-pulse text-sm">Loading…</span>
    </div>
  );
}
