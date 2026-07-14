// End-to-end WebRTC data-channel test driver.
//
// Assumes a backend (+ Postgres + Redis) is running and a REAL Rust agent is
// connected in `service` mode for device E2E_DEVICE_ID. This driver acts as the
// technician: it logs in, starts a session, then uses a headless Chromium
// (answerer.html) as a real WebRTC peer that answers the agent's offer, opens
// the input/clipboard/file data channels, and sends one message on each. It then
// asserts the corresponding audit events (input.command_attempt, clipboard.sync,
// file.transfer) were persisted by the backend.
//
// This exercises the entire platform except the Windows-only screen capture and
// input injection (which are documented stubs): real signaling, real WebRTC
// peer connection + data channels, real agent-side validation, and the real
// audit pipeline.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:18080';
const WS_BASE = process.env.E2E_WS_BASE || 'ws://127.0.0.1:18080';
const DEVICE_ID = req('E2E_DEVICE_ID');
const TECH_EMAIL = process.env.E2E_TECH_EMAIL || 'admin@example.com';
const TECH_PASSWORD = process.env.E2E_TECH_PASSWORD || 'devadminpassword';
const PAGE_PORT = parseInt(process.env.E2E_PAGE_PORT || '3999', 10);

// Resolve a Chromium binary: explicit CHROME_PATH, else the sandbox's
// pre-installed build, else let Playwright use its own bundled browser.
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return undefined; // Playwright picks its bundled browser.
}

function req(name) {
  const v = process.env[name];
  if (!v) { console.error('missing env', name); process.exit(2); }
  return v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(label, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await fn(); if (r) return r; await sleep(200); }
  throw new Error('timeout waiting for ' + label);
}

async function api(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

function servePage() {
  const html = fs.readFileSync(path.join(__dirname, 'answerer.html'), 'utf8');
  const server = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/html' });
    rs.end(html);
  });
  return new Promise((resolve) => server.listen(PAGE_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const pageServer = await servePage();
  console.log('[e2e] answerer page served on http://127.0.0.1:' + PAGE_PORT);

  // 1. Log in as the technician.
  const login = await api('POST', '/api/v1/auth/login', null, { email: TECH_EMAIL, password: TECH_PASSWORD });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  const token = login.json.token;
  console.log('[e2e] logged in');

  // 2. Wait for the agent's device to be online (it heartbeats in service mode).
  await poll('device online', 20000, async () => {
    const r = await api('GET', '/api/v1/devices', token);
    return (r.json?.devices || []).some((d) => d.id === DEVICE_ID && d.status === 'online');
  });
  console.log('[e2e] agent device is online');

  // 3. Launch the browser peer and pre-load the page (idle until __connect).
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Expose real host IPs instead of mDNS ".local" candidates, which a native
      // (non-browser) WebRTC peer on the same host cannot resolve.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[browser]', m.text()));
  await page.goto('http://127.0.0.1:' + PAGE_PORT + '/answerer.html');

  // 4. Start the session; the agent will show its banner and send the offer.
  const sess = await api('POST', '/api/v1/sessions', token, { device_id: DEVICE_ID });
  if (sess.status !== 201) throw new Error('create session failed: ' + sess.status + ' ' + JSON.stringify(sess.json));
  const sid = sess.json.session.id;
  console.log('[e2e] session created', sid);

  // 5. Connect the technician peer NOW (socket up before the agent offers).
  await page.evaluate(([s, t, w]) => window.__connect(s, t, w), [sid, token, WS_BASE]);

  // 6. Wait for the peer connection + all channels + messages sent.
  try {
    await poll('data-channel messages sent', 25000, async () => {
      const st = await page.evaluate(() => window.__e2e);
      if (st.error) throw new Error('browser peer error: ' + st.error);
      return st.messagesSent;
    });
  } catch (e) {
    const snapshot = await page.evaluate(() => window.__e2e).catch(() => null);
    console.log('[e2e] peer state at failure:', JSON.stringify(snapshot));
    throw e;
  }
  const st = await page.evaluate(() => window.__e2e);
  console.log('[e2e] peer state:', JSON.stringify(st));
  if (st.connState !== 'connected' && st.connState !== 'connecting' && st.connState !== 'completed') {
    // messagesSent implies channels opened, which implies the transport is up.
    console.log('[e2e] note: connState =', st.connState);
  }

  // 6b. Assert the screen stream works end to end: the agent's synthetic capture
  //     was JPEG-encoded, chunked over the `screen` channel, reassembled, and
  //     decoded to a real ImageBitmap of the expected size in the browser.
  const screen = await poll('screen frame decoded', 15000, async () => {
    const s = await page.evaluate(() => window.__e2e.screen);
    return s.decoded ? s : null;
  });
  if (screen.width !== 320 || screen.height !== 240) {
    throw new Error(`decoded screen frame has wrong size: ${screen.width}x${screen.height}`);
  }
  console.log(`[e2e] screen stream verified: decoded ${screen.frames} frame(s) at ${screen.width}x${screen.height}`);

  // 7. Let the immediate clipboard/file reports land, then end the session so
  //    the agent flushes its aggregated input counter.
  await sleep(1500);
  await api('POST', `/api/v1/sessions/${sid}/end`, token);
  console.log('[e2e] session ended; waiting for audit events');

  // 8. Assert the three data-channel audit events were persisted.
  const want = ['file.transfer', 'clipboard.sync', 'input.command_attempt'];
  const got = await poll('audit events', 15000, async () => {
    const r = await api('GET', `/api/v1/audit?session_id=${sid}&limit=100`, token);
    const types = new Set((r.json?.events || []).map((e) => e.event_type));
    if (want.every((w) => types.has(w))) return types;
    return null;
  });
  console.log('[e2e] audit event types for session:', [...got].sort().join(', '));

  await browser.close();
  pageServer.close();
  console.log('\nE2E PASS: real backend + real Rust agent + browser WebRTC peer — data channels established, screen frame decoded, and all three audit events persisted.');
}

main().catch((e) => {
  console.error('\nE2E FAIL:', e.message);
  process.exit(1);
});
