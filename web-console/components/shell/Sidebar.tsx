"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MonitorSmartphone,
  ScrollText,
  Users,
  Settings,
  BarChart3,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { RelayHealthPill } from "./RelayHealth";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const MAIN: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/audit", label: "Audit log", icon: ScrollText },
];

const ADMIN: NavItem[] = [
  { href: "/admin/technicians", label: "Technicians", icon: Users },
  { href: "/admin/reports", label: "Reports", icon: BarChart3 },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active =
    pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-surface-hover text-fg"
          : "text-fg-muted hover:bg-surface-hover hover:text-fg",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
        />
      )}
      <Icon
        className={cn("h-[18px] w-[18px]", active ? "text-accent" : "")}
        aria-hidden
      />
      {item.label}
    </Link>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
      {/* Wordmark */}
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-accent-fg">
          <ShieldCheck className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-fg">
          Remote<span className="text-fg-muted">Support</span>
        </span>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div className="space-y-0.5">
          {MAIN.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </div>
        <div>
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Administration
          </div>
          <div className="space-y-0.5">
            {ADMIN.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </div>
        </div>
      </nav>

      {/* Relay / system health */}
      <div className="border-t border-line p-3">
        <RelayHealthPill />
      </div>
    </aside>
  );
}
