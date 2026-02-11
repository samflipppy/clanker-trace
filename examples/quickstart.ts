/**
 * Clanker Trace — Zero-Config Quickstart (Node.js)
 *
 * Before (8 lines of instrumentation):
 *   const tracer = new ClankerTrace({ endpoint: '...', apiKey: '...', agentId: '...' });
 *   const run = await tracer.startRun({ goal: task.goal });
 *   ...manual trackLLM, trackTool wrappers everywhere...
 *   await run.complete();
 *   await tracer.shutdown();
 *
 * After (5 lines, auto-instrumented):
 *   export CLANKER_API_KEY=ct_xxx
 *   npx tsx examples/quickstart.ts
 */

import { init } from '../sdk/node/src/index';
import { instrument, uninstrument } from '../sdk/node/src/auto';

// That's it. Environment variables handle the rest:
//   CLANKER_API_KEY=ct_xxx  (required)
//   CLANKER_ENDPOINT=...    (defaults to https://api.clankertrace.com)
//   CLANKER_AGENT_ID=...    (defaults to "default")

async function main() {
  const ct = init();                                              // 1 line
  const run = await ct.startRun({ goal: 'Process customer request' }); // 1 line
  instrument(run);                                                // 1 line — all OpenAI calls are now traced

  try {
    // Your existing agent code — UNCHANGED.
    // If you use the OpenAI SDK, every call is automatically captured.
    // const openai = new OpenAI();
    // const res = await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
    // ^ auto-emits llm_invocation with model, tokens, latency, cost

    // Simulate some work
    await new Promise(r => setTimeout(r, 100));

    await run.complete();                                         // 1 line
  } catch (err) {
    await run.fail(String(err));
  } finally {
    uninstrument();
    await ct.shutdown();                                          // 1 line
  }
}

main().then(() => console.log('Done — check your traces'));
