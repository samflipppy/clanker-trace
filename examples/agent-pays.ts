/**
 * Agent Self-Payment Example — Stripe Machine Payments + Clanker Trace
 *
 * Demonstrates the full autonomous billing loop:
 * 1. Agent checks its credit balance
 * 2. If low, agent requests a deposit address from Clanker Trace
 * 3. Agent sends USDC to that address (via x402/Base)
 * 4. Credits are confirmed, agent continues tracing
 *
 * This is the core product thesis: agents pay for their own observability.
 */

import { init } from '../sdk/node/src/index';

const CLANKER_ENDPOINT = process.env.CLANKER_ENDPOINT || 'http://localhost:3100';
const CLANKER_API_KEY = process.env.CLANKER_API_KEY || 'ct_dev';
const LOW_BALANCE_THRESHOLD = 1000;
const REFILL_AMOUNT = 50000; // 50K credits ≈ $5 USDC

async function apiCall(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${CLANKER_ENDPOINT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CLANKER_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function ensureCredits(): Promise<void> {
  // Step 1: Check balance
  const balance = await apiCall('GET', '/v1/billing/balance');
  console.log(`Current balance: ${balance.effective_balance} credits`);

  if (balance.effective_balance >= LOW_BALANCE_THRESHOLD) {
    console.log('Balance sufficient, continuing...');
    return;
  }

  // Step 2: Request deposit address from Clanker Trace
  console.log(`Balance low (${balance.effective_balance}), requesting deposit...`);
  const deposit = await apiCall('POST', '/v1/billing/deposit', {
    amount: REFILL_AMOUNT,
    currency: 'usdc',
    chain: 'base',
  });

  console.log('Deposit instructions:');
  console.log(`  Send ${deposit.instructions.amount} USDC to ${deposit.instructions.to}`);
  console.log(`  Chain: ${deposit.instructions.chain}`);
  console.log(`  Payment Intent: ${deposit.payment_intent_id}`);

  // Step 3: In production, the agent would call its wallet SDK:
  //   await wallet.sendUSDC(deposit.instructions.to, deposit.instructions.amount);
  //
  // For this demo, we simulate by calling the confirm endpoint directly.
  const confirmation = await apiCall('POST', `/v1/billing/confirm/${deposit.payment_intent_id}`, {
    credits: REFILL_AMOUNT,
    deposit_address: deposit.deposit_address,
  });

  console.log(`Credits confirmed: +${confirmation.credits_added}, new balance: ${confirmation.new_balance}`);
}

async function runAgent(): Promise<void> {
  // Ensure we have credits before starting
  await ensureCredits();

  // Now run the agent with full tracing
  const ct = init({ apiKey: CLANKER_API_KEY, endpoint: CLANKER_ENDPOINT, agentId: 'self-paying-agent' });
  const run = await ct.startRun({ goal: 'Autonomous research task' });

  try {
    // Agent does its work, traces are captured, credits are consumed per-event
    run.emit('reasoning_step', { thought: 'Analyzing the problem space...' });

    await run.group('Research', 'tool_chain', async (g) => {
      g.emit('tool_invocation', { tool_name: 'web_search', arguments: { query: 'AI agent billing' } });
      g.emit('tool_response', { tool_name: 'web_search', result: '10 results found', success: true });
    });

    await run.complete({ cost: 0.005, tokens: 800 });
  } catch (err) {
    await run.fail(String(err));
  }

  // Check what we spent
  const usage = await apiCall('GET', '/v1/billing/usage');
  console.log('\nUsage summary:', JSON.stringify(usage, null, 2));

  await ct.shutdown();
}

runAgent()
  .then(() => console.log('\nAgent completed — paid for its own observability'))
  .catch(err => console.error('Agent failed:', err));
