/**
 * Self-hosted Clanker Trace server.
 *
 * This is the entry point for users who self-host. It runs the full
 * server (ingest + query + billing) with their own storage.
 *
 * You (Clanker) host NOTHING. User's data stays on their machine.
 * You only sell license keys via billing.clankertrace.com.
 *
 * Usage:
 *   # Free mode — no license needed, everything works
 *   npx clanker-trace serve
 *
 *   # Licensed mode — validates signed key, no phone-home per request
 *   CLANKER_LICENSE_KEY=ct_lic_xxx npx clanker-trace serve
 *
 *   # Docker
 *   docker run -p 3100:3100 -v ./data:/data clankertrace/server
 *
 * Environment variables:
 *   PORT                    — Server port (default: 3100)
 *   CLANKER_DB_PATH         — SQLite database path (default: ./clanker-trace.db)
 *   CLANKER_BILLING_MODE    — 'free' | 'license' | 'local' (default: 'free')
 *   CLANKER_LICENSE_KEY     — Signed license key from billing.clankertrace.com
 *   CLANKER_LICENSE_SECRET  — HMAC secret for license validation (set by billing server)
 */

import { createApp } from './index';

const port = process.env.PORT || 3100;
const dbPath = process.env.CLANKER_DB_PATH || undefined;
const billingMode = process.env.CLANKER_BILLING_MODE || 'free';

console.log(`
┌─────────────────────────────────────┐
│  Clanker Trace (self-hosted)        │
│                                     │
│  Billing: ${billingMode.padEnd(26)}│
│  Storage: Local SQLite              │
│  Your data never leaves this machine│
└─────────────────────────────────────┘
`);

const { app } = createApp(dbPath);

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);

  if (billingMode === 'free') {
    console.log('\nRunning in free mode — no credit limits.');
    console.log('To enable billing: set CLANKER_BILLING_MODE=license and CLANKER_LICENSE_KEY');
  }
});
