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
    <div className="flex min-h-[60vh] items-center justify-center text-slate-500">
      <span className="animate-pulse">Loading…</span>
    </div>
  );
}
