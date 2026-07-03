"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Lock, KeyRound, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { login as apiLogin, ApiError } from "@/lib/api";
import { Button, Input, Field, Alert } from "@/components/ui";

export default function LoginPage() {
  const { token, loading, login } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && token) router.replace("/dashboard");
  }, [loading, token, router]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiLogin(email, password);
      login(res.token, res.technician, res.expires_at);
      router.replace("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message || "Invalid email or password."
          : "Unexpected error during sign-in.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4 py-10">
      <div className="w-full max-w-[380px]">
        {/* Wordmark */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-accent text-accent-fg shadow-elev-2">
            <ShieldCheck className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">
            Sign in to Remote Support
          </h1>
          <p className="mt-1.5 text-[13px] text-fg-muted">
            Technician console for consented, audited remote sessions.
          </p>
        </div>

        <div className="surface-card p-6 shadow-elev-2">
          {/* SSO placeholder */}
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled
            title="SSO is configured by your administrator (coming soon)"
            icon={<KeyRound className="h-4 w-4" aria-hidden />}
          >
            Continue with SSO
          </Button>
          <div className="my-5 flex items-center gap-3 text-[12px] text-fg-muted">
            <span className="h-px flex-1 bg-line" />
            or sign in with email
            <span className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={!!error}
                required
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={!!error}
                required
              />
            </Field>

            {error && <Alert kind="danger">{error}</Alert>}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={submitting}
              iconRight={
                !submitting && <ArrowRight className="h-4 w-4" aria-hidden />
              }
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {/* MFA placeholder note */}
          <p className="mt-4 text-center text-[12px] text-fg-muted">
            Multi-factor authentication is enforced per organization policy.
          </p>
        </div>

        {/* Trust reassurance */}
        <div className="mt-6 flex items-center justify-center gap-2 text-[12px] text-fg-muted">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Sessions are end-to-end encrypted, consent-gated, and fully audited.
        </div>
      </div>
    </div>
  );
}
