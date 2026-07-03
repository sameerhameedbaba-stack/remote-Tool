"use client";

// Authentication context + route guard.
//
// Token storage tradeoff (MVP):
//   The JWT is held in React state (in-memory) AND mirrored to a cookie so a
//   full-page reload can rehydrate the session. A pure in-memory token is the
//   most XSS-resistant option but does not survive reloads; a proper hardening
//   would use an httpOnly cookie set by the backend (invisible to JS). Since
//   this MVP's backend hands the token to the browser directly, we store it in
//   a non-httpOnly cookie — readable by JS and therefore XSS-exposed. This is
//   the documented, ROADMAP-tracked limitation (see ARCHITECTURE.md §2.3).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { getMe, type Technician } from "./api";

const TOKEN_COOKIE = "rs_token";
const TECH_COOKIE = "rs_tech";

interface AuthState {
  token: string | null;
  technician: Technician | null;
  // `loading` is true only during the initial cookie rehydration.
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (token: string, technician: Technician, expiresAt: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// --- Cookie helpers (client-only) ---

function setCookie(name: string, value: string, expires?: Date): void {
  if (typeof document === "undefined") return;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "path=/",
    "SameSite=Lax",
  ];
  if (expires) parts.push(`expires=${expires.toUTCString()}`);
  document.cookie = parts.join("; ");
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [technician, setTechnician] = useState<Technician | null>(null);
  const [loading, setLoading] = useState(true);

  // Rehydrate from cookie on first mount.
  useEffect(() => {
    const storedToken = getCookie(TOKEN_COOKIE);
    const storedTech = getCookie(TECH_COOKIE);
    if (!storedToken) {
      setLoading(false);
      return;
    }
    setToken(storedToken);
    if (storedTech) {
      try {
        setTechnician(JSON.parse(storedTech) as Technician);
      } catch {
        /* ignore malformed cookie */
      }
    }
    // Best-effort refresh of the technician object; if the token is invalid
    // the guard will bounce the user to /login on the next protected render.
    getMe(storedToken)
      .then((tech) => {
        setTechnician(tech);
        setCookie(TECH_COOKIE, JSON.stringify(tech));
      })
      .catch(() => {
        deleteCookie(TOKEN_COOKIE);
        deleteCookie(TECH_COOKIE);
        setToken(null);
        setTechnician(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(
    (newToken: string, tech: Technician, expiresAt: string) => {
      const expires = new Date(expiresAt);
      const validExpiry = Number.isNaN(expires.getTime())
        ? undefined
        : expires;
      setToken(newToken);
      setTechnician(tech);
      setCookie(TOKEN_COOKIE, newToken, validExpiry);
      setCookie(TECH_COOKIE, JSON.stringify(tech), validExpiry);
    },
    [],
  );

  const logout = useCallback(() => {
    setToken(null);
    setTechnician(null);
    deleteCookie(TOKEN_COOKIE);
    deleteCookie(TECH_COOKIE);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ token, technician, loading, login, logout }),
    [token, technician, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

// Route guard: renders children only when authenticated; otherwise redirects
// to /login. Shows a lightweight loading state during rehydration.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !token) {
      router.replace("/login");
    }
  }, [loading, token, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        <span className="animate-pulse">Loading…</span>
      </div>
    );
  }

  if (!token) {
    return null;
  }

  return <>{children}</>;
}
