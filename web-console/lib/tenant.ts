// Tenant/subdomain awareness for the multi-tenant platform.
//
// The same console is served on several host shapes and renders accordingly:
//   <apex>            → marketing / login
//   admin.<apex>      → platform super-admin
//   <username>.<apex> → a technician's tenant panel
//   connect.<apex>    → host onboarding (static page, not this app)
//
// These are best-effort, browser-only helpers driven by window.location.host.

export type TenantKind = "apex" | "admin" | "connect" | "tenant";

const FIXED = new Set(["admin", "connect", "www"]);

// The leading label of the host, or null for an apex/localhost host.
export function subdomainLabel(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.host.split(":")[0];
  const parts = host.split(".");
  if (parts.length <= 2) return null; // apex (tiefixy.com) or localhost
  return parts[0].toLowerCase();
}

// The apex platform domain (host with any leading admin./www. stripped).
export function platformDomain(): string {
  if (typeof window === "undefined") return "";
  return window.location.host.replace(/^admin\./, "").replace(/^www\./, "");
}

export function tenantKind(): TenantKind {
  const label = subdomainLabel();
  if (label === null || label === "www") return "apex";
  if (label === "admin") return "admin";
  if (label === "connect") return "connect";
  return "tenant";
}

// The tenant username when on a <username>.<apex> host, else null.
export function tenantUsername(): string | null {
  const label = subdomainLabel();
  if (label && !FIXED.has(label)) return label;
  return null;
}
