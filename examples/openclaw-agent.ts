/**
 * OpenClaw-Style Agent — Clanker Trace Integration Example
 *
 * Demonstrates that the SDK works cleanly with OpenClaw execution loops
 * and tool chains without requiring structural changes. Validates:
 *
 *  1. Runs wrap an entire OpenClaw task loop (start → complete)
 *  2. LLM calls, tool invocations, memory retrieval, retries, and errors
 *     are captured reliably via the existing SDK primitives
 *  3. Batching (default 50 events / 1s flush) introduces no timing issues —
 *     emit() is synchronous queue-push, flushes happen in the background
 *  4. No blocking latency during heavy tool usage — only startRun() and
 *     complete()/fail() are async; everything else is fire-and-forget
 *  5. Instrumentation is ~8 lines on top of existing agent code
 *
 * Usage:
 *   CLANKER_ENDPOINT=http://localhost:3000 CLANKER_API_KEY=ct_xxx npx tsx examples/openclaw-agent.ts
 */

import { ClankerTrace, TracedRun } from '../sdk/node/src/index';

// ---------------------------------------------------------------------------
// Simulated OpenClaw primitives (stand-ins for the real framework)
// ---------------------------------------------------------------------------

interface Task { goal: string; tools: string[] }

async function callLLM(prompt: string): Promise<{ response: string; tokens: number; cost: number }> {
  await sleep(50 + Math.random() * 100);               // simulate latency
  return { response: `Plan: use tools to accomplish "${prompt}"`, tokens: 420, cost: 0.002 };
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  await sleep(30 + Math.random() * 80);
  if (name === 'flaky_api' && Math.random() < 0.4) throw new Error('503 Service Unavailable');
  return { ok: true, data: `${name} result` };
}

async function queryMemory(query: string): Promise<string[]> {
  await sleep(20);
  return ['Prior result A', 'Context snippet B'];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// The OpenClaw-style agent loop — BEFORE instrumentation it looks like this:
//
//   async function runAgent(task: Task) {
//     const memories = await queryMemory(task.goal);
//     const plan = await callLLM(task.goal);
//     for (const tool of task.tools) {
//       await executeTool(tool, {});
//     }
//   }
//
// AFTER instrumentation (8 added lines, marked with ← ):
// ---------------------------------------------------------------------------

async function runAgent(task: Task) {
  const tracer = new ClankerTrace({                                  // ← 1
    endpoint: process.env.CLANKER_ENDPOINT || 'http://localhost:3000',
    apiKey:   process.env.CLANKER_API_KEY   || 'ct_dev',
    agentId:  'openclaw-research-agent',
  });
  const run = await tracer.startRun({ goal: task.goal });            // ← 2

  try {
    // --- Memory retrieval (grouped) ---
    await run.group('Retrieve context', 'memory_sequence', async (g) => {
      const memories = await queryMemory(task.goal);
      g.emit('memory_query', { query: task.goal });
      g.emit('memory_response', { results: memories, count: memories.length });
      return memories;
    });

    // --- Reasoning / planning (grouped) ---
    const plan = await run.group('LLM Planning', 'reasoning', async (g) => {
      return g.trackLLM('gpt-4o', () => callLLM(task.goal));        // ← 3
    });

    // --- Tool execution chain (grouped) ---
    await run.group('Execute tools', 'tool_chain', async (g) => {
      for (const tool of task.tools) {
        // Retry loop — retries are captured automatically
        let lastErr: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await g.trackTool(tool, { attempt }, () =>               // ← 4
              executeTool(tool, { attempt }),
            );
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err as Error;
            g.emit('retry_attempt', {                                // ← 5
              tool_name: tool,
              attempt: attempt + 1,
              error: String(err),
            });
          }
        }
        if (lastErr) {
          g.emit('error_raised', { tool_name: tool, error: String(lastErr) }, { error: true });
        }
      }
    });

    await run.complete({ cost: 0.01, tokens: 1200 });               // ← 6
  } catch (err) {
    await run.fail(String(err));                                     // ← 7
  } finally {
    await tracer.shutdown();                                         // ← 8
  }
}

// ---------------------------------------------------------------------------
// Run the example
// ---------------------------------------------------------------------------

const task: Task = {
  goal: 'Research competitive landscape for AI observability tools',
  tools: ['web_search', 'flaky_api', 'summarizer'],
};

runAgent(task)
  .then(() => console.log('✔ Agent run completed — check the Clanker Trace dashboard'))
  .catch(err => console.error('✗ Agent run failed:', err));
