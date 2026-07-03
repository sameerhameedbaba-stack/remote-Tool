/** @type {import('next').NextConfig} */

// Backend origins the browser must be allowed to reach (REST + signaling WS).
// These are non-secret, build-time public envs; fall back to the local defaults.
const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8080";
const wsOrigin = process.env.NEXT_PUBLIC_WS_BASE_URL || "ws://localhost:8080";
const isDev = process.env.NODE_ENV !== "production";

// Pragmatic CSP: the app ships no external hosts, but it must reach the API over
// HTTP(S) and the signaling socket over WS(S). 'unsafe-inline' is required for
// Next's inlined bootstrap + Tailwind's injected styles; 'unsafe-eval' only in
// dev (React Refresh). frame-ancestors 'none' hard-blocks clickjacking.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  `connect-src 'self' ${apiOrigin} ${wsOrigin} ws: wss:`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
]
  .join("; ")
  .concat(";");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle so the Docker image can run without
  // the full node_modules tree. See infra/docker-compose.yml + Dockerfile.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
