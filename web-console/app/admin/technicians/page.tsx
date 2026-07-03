"use client";

import { UserPlus, ShieldCheck, KeyRound } from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { Card, Button, StatusBadge } from "@/components/ui";
import { PageHeader, ComingSoonPill } from "@/components/domain/admin";

function TechniciansContent() {
  const { technician } = useAuth();
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      <PageHeader
        title="Technicians"
        description="Manage who can access devices and run support sessions."
        action={
          <Button variant="primary" icon={<UserPlus className="h-4 w-4" aria-hidden />} disabled>
            Invite technician
          </Button>
        }
      />

      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-[13px] font-semibold text-fg">Members</span>
          <ComingSoonPill />
        </div>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-fg-muted">
              <th className="px-5 py-2.5 font-medium">Technician</th>
              <th className="px-5 py-2.5 font-medium">Role</th>
              <th className="px-5 py-2.5 font-medium">MFA</th>
              <th className="px-5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr className="hover:bg-surface-hover">
              <td className="px-5 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
                    {(technician?.display_name || "?").charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <div className="font-medium text-fg">
                      {technician?.display_name} <span className="text-[12px] text-fg-muted">(you)</span>
                    </div>
                    <div className="text-[12px] text-fg-muted">{technician?.email}</div>
                  </div>
                </div>
              </td>
              <td className="px-5 py-3">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-[12px] capitalize text-fg-secondary">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  {technician?.role}
                </span>
              </td>
              <td className="px-5 py-3">
                <StatusBadge kind="neutral" size="sm">Per policy</StatusBadge>
              </td>
              <td className="px-5 py-3">
                <StatusBadge kind="success" size="sm">Active</StatusBadge>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="border-t border-line px-5 py-3 text-[12px] text-fg-muted">
          Listing, inviting, roles, and per-technician MFA require a technician-
          management API (backend TODO). Only your own profile is shown today.
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <KeyRound className="h-4 w-4 text-fg-muted" aria-hidden /> Roles &amp; permissions
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">
            Define permission profiles (view-only, control, file transfer, admin)
            and assign them per technician or group.
          </p>
          <div className="mt-3"><ComingSoonPill /></div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <ShieldCheck className="h-4 w-4 text-fg-muted" aria-hidden /> Access reviews
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">
            Periodic attestation of who can access which device groups, with an
            exportable trail.
          </p>
          <div className="mt-3"><ComingSoonPill /></div>
        </Card>
      </div>
    </div>
  );
}

export default function TechniciansPage() {
  return (
    <RequireAuth>
      <TechniciansContent />
    </RequireAuth>
  );
}
