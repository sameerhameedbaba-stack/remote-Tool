"use client";

import type { ReactNode } from "react";
import {
  Building2,
  ShieldCheck,
  Video,
  Clock,
  Palette,
  Globe,
  Sun,
  Moon,
} from "lucide-react";
import { RequireAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Card, Button } from "@/components/ui";
import { PageHeader, ComingSoonPill } from "@/components/domain/admin";
import { cn } from "@/lib/cn";

function Section({
  icon,
  title,
  description,
  children,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-hover text-fg-secondary">
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-fg">{title}</h3>
            <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>
          </div>
        </div>
        {badge}
      </div>
      {children && <div className="mt-4 border-t border-line pt-4">{children}</div>}
    </Card>
  );
}

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <div className="text-[12px] text-fg-muted">{hint}</div>}
      </div>
      {control}
    </div>
  );
}

function DisabledToggle({ on }: { on?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-9 items-center rounded-full px-0.5 opacity-60",
        on ? "bg-accent" : "bg-line",
      )}
      aria-hidden
    >
      <span
        className={cn(
          "h-4 w-4 rounded-full bg-white transition-transform",
          on && "translate-x-4",
        )}
      />
    </span>
  );
}

function SettingsContent() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-7">
      <PageHeader
        title="Settings"
        description="Organization, security, and session policy."
      />

      <div className="space-y-4">
        {/* Appearance — functional */}
        <Section
          icon={<Palette className="h-4 w-4" aria-hidden />}
          title="Appearance"
          description="Choose the console theme. Dark is recommended for long sessions."
        >
          <div className="flex gap-2">
            {(["dark", "light"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium capitalize transition-colors",
                  theme === t
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface text-fg-secondary hover:text-fg",
                )}
              >
                {t === "dark" ? (
                  <Moon className="h-4 w-4" aria-hidden />
                ) : (
                  <Sun className="h-4 w-4" aria-hidden />
                )}
                {t}
              </button>
            ))}
          </div>
        </Section>

        <Section
          icon={<Building2 className="h-4 w-4" aria-hidden />}
          title="Organization"
          description="Name, logo, and tenant identity."
          badge={<ComingSoonPill />}
        />

        <Section
          icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
          title="Security"
          description="Authentication and network controls."
          badge={<ComingSoonPill />}
        >
          <div className="divide-y divide-line">
            <Row label="Enforce multi-factor authentication" hint="Require MFA for all technicians" control={<DisabledToggle on />} />
            <Row label="Single sign-on (SSO)" hint="SAML / OIDC identity provider" control={<DisabledToggle />} />
            <Row label="IP allowlist" hint="Restrict console access by IP range" control={<DisabledToggle />} />
          </div>
        </Section>

        <Section
          icon={<Clock className="h-4 w-4" aria-hidden />}
          title="Session policy"
          description="Consent, duration, and idle behavior."
          badge={<ComingSoonPill />}
        >
          <div className="divide-y divide-line">
            <Row label="Require end-user consent" hint="Enforced in the MVP — cannot be disabled" control={<DisabledToggle on />} />
            <Row label="Maximum session duration" hint="Auto-end after a set time" control={<DisabledToggle />} />
            <Row label="Idle disconnect" hint="Disconnect after inactivity" control={<DisabledToggle />} />
          </div>
        </Section>

        <Section
          icon={<Video className="h-4 w-4" aria-hidden />}
          title="Recording & retention"
          description="Session recording and data-retention policy."
          badge={<ComingSoonPill />}
        >
          <div className="divide-y divide-line">
            <Row label="Record sessions" hint="Store an encrypted recording of each session" control={<DisabledToggle />} />
            <Row label="Audit retention" hint="How long audit events are kept" control={<span className="text-[13px] text-fg-muted">Unlimited (MVP)</span>} />
          </div>
        </Section>

        <Section
          icon={<Globe className="h-4 w-4" aria-hidden />}
          title="Branding"
          description="Custom logo, colors, and support URL on the end-user agent."
          badge={<ComingSoonPill />}
        />
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="primary" disabled>Save changes</Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <RequireAuth>
      <SettingsContent />
    </RequireAuth>
  );
}
