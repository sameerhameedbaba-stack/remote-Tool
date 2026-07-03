"use client";

// Shared top navigation. Rendered only when a technician is authenticated.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/devices", label: "Devices" },
  { href: "/audit", label: "Audit" },
] as const;

export function NavBar() {
  const { token, technician, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Nav is hidden entirely when unauthenticated (login screen has no chrome).
  if (!token) return null;

  const onLogout = () => {
    logout();
    router.replace("/login");
  };

  return (
    <header className="sticky top-0 z-40 border-b border-surface-700 bg-surface-900/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-8">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-semibold text-white"
          >
            <span className="grid h-7 w-7 place-items-center rounded bg-accent-500 text-sm font-bold text-white">
              R
            </span>
            <span>Remote Support</span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const active =
                pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-surface-700 text-white"
                      : "text-slate-400 hover:bg-surface-800 hover:text-slate-200"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {technician && (
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium text-slate-200">
                {technician.display_name}
              </div>
              <div className="text-xs text-slate-500">{technician.email}</div>
            </div>
          )}
          <button onClick={onLogout} className="btn-secondary">
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
