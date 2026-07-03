# Roadmap — Remote Support MVP

What the MVP deliberately defers, ordered roughly by how soon a first paying
customer would need it. Everything here is a conscious deferral, not an
oversight; the MVP is built so these can be added without rearchitecting.

## Near-term hardening (before/at first paid deployment)

1. **TLS everywhere.** Terminate TLS in front of the backend and console (or in
   the backend) and require `wss://` for signaling. Currently the operator must
   put a TLS terminator in front; compose ships plaintext for localhost.
2. **Signed auto-update for the agent.** Implement the `update` module: signed
   manifest, pinned public key verification, staged download + verify + swap,
   plus a CI signing step and Authenticode signing of the Windows binary. The
   interface already exists.
3. **Per-tenant, revocable enrollment tokens.** Replace the single shared
   `AGENT_ENROLLMENT_TOKEN` with per-tenant, expiring, revocable enrollment
   tokens and a device-revocation path.
4. **Short-lived TURN credentials.** Switch coturn to `use-auth-secret` (TURN
   REST) so the console/agent get time-boxed relay credentials instead of static
   ones.
5. **Token revocation / refresh.** Add refresh tokens and a revocation list so a
   compromised technician JWT can be killed before its short TTL expires.
5a. **WebSocket auth tickets.** Replace the `?token=` query parameter on the
   signaling/agent sockets with a single-use, short-TTL ticket minted by an
   authenticated HTTP endpoint, so long-lived credentials never appear in URLs
   (and thus never in proxy/access logs).

## Capability completion (turn stubs into real features)

6. **Real screen capture.** Implement `ScreenSource` on Windows via DXGI Desktop
   Duplication; feed frames into the WebRTC video track with H.264/VP8 encoding.
7. **Real input injection.** Implement the Windows `SendInput` path behind the
   existing validated-input interface (allowlist + normalized coords already
   enforced).
8. **Native banner window.** Replace the console-level banner with an always-on-
   top, non-suppressible native window on Windows; keep the state-machine gate
   that blocks `active` until the banner is confirmed visible.
9. **DPAPI token storage on Windows.** Finish `CryptProtectData` storage for the
   device token (machine scope for the service); remove the dev file fallback in
   production builds.
10. **Robust file transfer.** Resumable transfers, integrity hashes, progress UI,
    and per-session transfer quotas.

## Scale & operability

11. **Clustered signaling hub.** Move session routing to a shared backplane
    (Redis pub/sub or NATS) so the signaling hub can run multiple replicas.
12. **Shared rate limiting.** Replace the in-process limiter on `/attended/join`
    with a Redis-backed limiter that holds across replicas.
13. **Object storage for transfers.** Move file transfer to S3-compatible storage
    (deferred from the MVP by design) for large files and retention.
14. **Observability.** Metrics (Prometheus), tracing, and audit-log export /
    retention policies.

## Explicitly out of scope (not on this roadmap)

Per the product definition, the following are **not** planned for this product
line and were never built: RMM, PAM, mobile agents/viewers, Linux/macOS agents,
plugin SDK, GraphQL, OpenSearch, Kubernetes, enterprise SSO, anomaly detection,
any AI features, and — as a hard safety boundary — terminal / PowerShell /
SYSTEM shell / remote script execution, credential vault, and any silent /
hidden / backstage session mode.

## Next 10 implementation tasks

A concrete, ordered backlog (also mirrored in the top-level README):

1. Terminate TLS for backend + console; force `wss://` signaling.
2. Implement Windows DXGI screen capture into the WebRTC video track.
3. Implement Windows `SendInput` behind the validated-input interface.
4. Build the always-on-top native Windows banner window.
5. Finish DPAPI device-token storage; drop the dev file fallback in release.
6. Implement the signed-update flow + Authenticode signing in CI.
7. Replace the shared enrollment token with per-tenant revocable tokens.
8. Add JWT refresh + revocation.
9. Switch coturn to short-lived TURN REST credentials.
10. Add end-to-end integration tests for the attended + unattended flows.
