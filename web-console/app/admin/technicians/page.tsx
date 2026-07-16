"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { UserPlus, ShieldCheck, Globe, Check, Ban } from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import {
  createTechnician,
  listTechnicians,
  setTechnicianActive,
  errorMessage,
  type Technician,
} from "@/lib/api";
import { Button, Card, Field, Input } from "@/components/ui";
import { PageHeader } from "@/components/domain/admin";

// Derive the apex platform domain from the current host (strip admin./www.).
function platformDomain(): string {
  if (typeof window === "undefined") return "";
  return window.location.host.replace(/^admin\./, "").replace(/^www\./, "");
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

function TechniciansContent() {
  const { token, technician } = useAuth();
  const isAdmin = technician?.role === "admin";

  const [rows, setRows] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const domain = useMemo(() => platformDomain(), []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const res = await listTechnicians(token, signal);
        setRows(res.technicians);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, "Failed to load technicians"));
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [isAdmin, load]);

  const onCreate = async () => {
    if (!token) return;
    setCreating(true);
    setError(null);
    try {
      await createTechnician(token, {
        email: email.trim(),
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
        password,
      });
      setEmail("");
      setUsername("");
      setDisplayName("");
      setPassword("");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to create technician"));
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (t: Technician) => {
    if (!token) return;
    setBusyId(t.id);
    try {
      await setTechnicianActive(token, t.id, !t.active);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to update technician"));
    } finally {
      setBusyId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="mx-auto w-full max-w-[900px] px-6 py-16 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-fg-muted" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold text-fg">Admins only</h1>
        <p className="mt-1 text-sm text-fg-muted">
          This panel is for platform administrators.
        </p>
      </div>
    );
  }

  const canCreate =
    email.includes("@") &&
    USERNAME_RE.test(username.trim().toLowerCase()) &&
    password.length >= 8 &&
    !creating;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-7">
      <PageHeader
        title="Technicians"
        description="Create technician accounts. Each gets their own panel at username.<your-domain>."
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Create */}
        <Card className="p-5 lg:col-span-1">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-accent" aria-hidden />
            <h2 className="text-sm font-semibold text-fg">New technician</h2>
          </div>
          <div className="mt-4 space-y-3">
            <Field label="Username (their subdomain)" htmlFor="t-username">
              <Input
                id="t-username"
                placeholder="jane"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
              />
              {username && (
                <p className="mt-1 text-[11px] text-fg-muted">
                  Panel:{" "}
                  <span className="font-medium text-fg">
                    {username}.{domain}
                  </span>
                </p>
              )}
            </Field>
            <Field label="Email" htmlFor="t-email">
              <Input
                id="t-email"
                type="email"
                placeholder="jane@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Display name" htmlFor="t-name">
              <Input
                id="t-name"
                placeholder="Jane Doe"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Field label="Temporary password (min 8 chars)" htmlFor="t-pass">
              <Input
                id="t-pass"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              onClick={onCreate}
              loading={creating}
              disabled={!canCreate}
              className="w-full"
            >
              Create technician
            </Button>
          </div>
        </Card>

        {/* List */}
        <Card className="p-0 lg:col-span-2">
          <div className="border-b border-line px-5 py-3 text-[13px] font-semibold text-fg">
            Technicians ({rows.length})
          </div>
          {loading ? (
            <div className="px-5 py-8 text-center text-sm text-fg-muted">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-fg-muted">
              No technicians yet. Create one on the left.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-fg-muted">
                    <th className="px-5 py-2.5 font-medium">Technician</th>
                    <th className="px-5 py-2.5 font-medium">Panel</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-hover">
                      <td className="px-5 py-3">
                        <div className="font-medium text-fg">
                          {t.display_name || t.username}
                        </div>
                        <div className="text-[12px] text-fg-muted">{t.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center gap-1 text-[12px] text-fg-secondary">
                          <Globe
                            className="h-3.5 w-3.5 text-fg-muted"
                            aria-hidden
                          />
                          {t.username}.{domain}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] " +
                            (t.active
                              ? "bg-success-soft text-success"
                              : "bg-surface-hover text-fg-muted")
                          }
                        >
                          {t.active ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === t.id}
                          onClick={() => void toggleActive(t)}
                          icon={
                            t.active ? (
                              <Ban className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Check className="h-3.5 w-3.5" aria-hidden />
                            )
                          }
                        >
                          {t.active ? "Disable" : "Enable"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
