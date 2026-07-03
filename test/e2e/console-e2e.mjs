// Console UI end-to-end test (Playwright).
//
// Drives the REAL Next.js technician console against a REAL backend and asserts
// the core operator flows: login (bad → error, good → dashboard), attended-code
// creation, the devices list showing an online device, the audit log, and the
// mandatory "REMOTE SESSION ACTIVE" banner on the session screen.
//
// Orchestrated by test/run-console-e2e.sh, which starts the backend + console
// and seeds an online device and a session.

import fs from 'node:fs';
import { chromium } from 'playwright';

const CONSOLE_URL = process.env.E2E_CONSOLE_URL || 'http://localhost:3000';
const TECH_EMAIL = process.env.E2E_TECH_EMAIL || 'admin@example.com';
const TECH_PASSWORD = process.env.E2E_TECH_PASSWORD || 'devadminpassword';
const DEVICE_NAME = req('E2E_DEVICE_NAME');
const SESSION_ID = req('E2E_SESSION_ID');

function req(name) {
  const v = process.env[name];
  if (!v) { console.error('missing env', name); process.exit(2); }
  return v;
}

// Explicit CHROME_PATH, else the sandbox build, else Playwright's own browser.
function resolveChrome() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return undefined;
}

const steps = [];
async function step(name, fn) {
  process.stdout.write(`[console-e2e] ${name} ... `);
  await fn();
  console.log('OK');
  steps.push(name);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  await step('login rejects bad credentials', async () => {
    await page.goto(CONSOLE_URL + '/login');
    await page.fill('#email', TECH_EMAIL);
    await page.fill('#password', 'definitely-wrong');
    await page.click('button[type=submit]');
    await page.waitForSelector('[role=alert]');
  });

  await step('login accepts good credentials → dashboard', async () => {
    await page.fill('#email', TECH_EMAIL);
    await page.fill('#password', TECH_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL('**/dashboard');
    await page.waitForSelector('h1:has-text("Dashboard")');
  });

  await step('dashboard creates a one-time attended code', async () => {
    await page.fill('input[aria-label="Session label"]', 'E2E laptop');
    await page.click('button:has-text("Create code")');
    const el = await page.waitForSelector('[aria-label^="Attended code"]');
    const label = await el.getAttribute('aria-label');
    if (!/\d{3}-\d{3}-\d{3}/.test(label || '')) {
      throw new Error('attended code not in expected format: ' + label);
    }
  });

  await step('devices page shows the online device', async () => {
    await page.goto(CONSOLE_URL + '/devices');
    await page.waitForSelector(`text=${DEVICE_NAME}`);
    const body = (await page.textContent('body')) || '';
    if (!/online/i.test(body)) throw new Error('no "online" status shown on devices page');
  });

  await step('audit page shows recorded events', async () => {
    await page.goto(CONSOLE_URL + '/audit');
    await page.waitForSelector('[data-testid="audit-row"]');
    const body = (await page.textContent('body')) || '';
    // Human-readable event labels rendered by the redesigned audit timeline.
    if (!/(Signed in|Device registered|Session (requested|started|ended)|Consent approved)/.test(body)) {
      throw new Error('audit page shows no expected event labels');
    }
  });

  await step('session screen renders the mandatory active-session banner', async () => {
    await page.goto(CONSOLE_URL + '/sessions/' + SESSION_ID);
    await page.waitForSelector('text=REMOTE SESSION ACTIVE');
  });

  // Optional: capture screenshots of each redesigned page for visual review.
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) {
    const fsmod = await import('node:fs');
    fsmod.mkdirSync(shotsDir, { recursive: true });
    const shot = async (name, url, waitFor) => {
      await page.goto(CONSOLE_URL + url);
      if (waitFor) await page.waitForSelector(waitFor).catch(() => {});
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: false });
      console.log(`[console-e2e] shot: ${name}`);
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot('dashboard', '/dashboard', 'h1');
    await shot('devices', '/devices', 'table');
    await shot('audit', '/audit', '[data-testid="audit-row"]');
    await shot('session', '/sessions/' + SESSION_ID, 'text=REMOTE SESSION ACTIVE');
    await shot('settings', '/admin/settings', 'h1');
    // Light mode dashboard.
    await page.goto(CONSOLE_URL + '/dashboard');
    await page.evaluate(() => {
      localStorage.setItem('rs-theme', 'light');
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shotsDir}/dashboard-light.png` });
    console.log('[console-e2e] shot: dashboard-light');
    // Login (sign out first).
    await page.goto(CONSOLE_URL + '/login');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForSelector('#email');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shotsDir}/login.png` });
    console.log('[console-e2e] shot: login');
  }

  await browser.close();
  console.log(`\nCONSOLE E2E PASS: ${steps.length} UI flows verified against the real backend.`);
}

main().catch((e) => {
  console.error('\nCONSOLE E2E FAIL:', e.message);
  process.exit(1);
});
