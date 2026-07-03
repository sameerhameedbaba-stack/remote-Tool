"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Search,
  Sun,
  Moon,
  LogOut,
  ChevronDown,
  Menu,
  LayoutDashboard,
  MonitorSmartphone,
  ScrollText,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { IconButton, Tooltip } from "@/components/ui";
import { Drawer } from "@/components/ui";
import { cn } from "@/lib/cn";

function openPalette() {
  window.dispatchEvent(new Event("rs:open-command"));
}

const MOBILE_NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/audit", label: "Audit log", icon: ScrollText },
];

export function TopBar() {
  const { technician, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const onLogout = () => {
    logout();
    router.replace("/login");
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur">
      <IconButton
        label="Open navigation"
        variant="ghost"
        className="lg:hidden"
        onClick={() => setMobileNav(true)}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </IconButton>

      {/* Quick connect / search — the fastest path to a session. */}
      <button
        onClick={openPalette}
        className="group flex h-9 w-full max-w-md items-center gap-2.5 rounded-lg border border-line bg-app px-3 text-left text-[13px] text-fg-muted transition-colors hover:border-line-soft"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="flex-1">Quick connect — search a device…</span>
        <kbd className="hidden rounded border border-line-soft bg-surface px-1.5 py-0.5 font-mono text-[11px] text-fg-muted sm:inline">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip label={theme === "dark" ? "Light mode" : "Dark mode"}>
          <IconButton label="Toggle theme" variant="ghost" onClick={toggle}>
            {theme === "dark" ? (
              <Sun className="h-[18px] w-[18px]" aria-hidden />
            ) : (
              <Moon className="h-[18px] w-[18px]" aria-hidden />
            )}
          </IconButton>
        </Tooltip>

        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-surface-hover"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
              {(technician?.display_name || technician?.email || "?")
                .charAt(0)
                .toUpperCase()}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-[13px] font-medium leading-tight text-fg">
                {technician?.display_name || "Technician"}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-fg-muted" aria-hidden />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-1.5 w-56 overflow-hidden rounded-xl border border-line bg-surface-raised shadow-pop animate-scale-in"
            >
              <div className="border-b border-line px-3 py-2.5">
                <div className="text-[13px] font-medium text-fg">
                  {technician?.display_name}
                </div>
                <div className="truncate text-[12px] text-fg-muted">
                  {technician?.email}
                </div>
                {technician?.role && (
                  <div className="mt-1 inline-flex rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] capitalize text-fg-secondary">
                    {technician.role}
                  </div>
                )}
              </div>
              <button
                role="menuitem"
                onClick={onLogout}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      <Drawer
        open={mobileNav}
        onClose={() => setMobileNav(false)}
        title="Navigation"
        width="max-w-[80vw]"
      >
        <nav className="space-y-1 p-3">
          {MOBILE_NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileNav(false)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                  active
                    ? "bg-surface-hover text-fg"
                    : "text-fg-secondary hover:bg-surface-hover",
                )}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </Drawer>
    </header>
  );
}
