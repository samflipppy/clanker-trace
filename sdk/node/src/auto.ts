/**
 * Auto-instrumentation for Clanker Trace.
 *
 * Monkey-patches the OpenAI SDK to automatically capture LLM calls
 * and tool use without manual trackLLM/trackTool wrappers.
 *
 * Usage:
 *   import { ClankerTrace } from '@clanker-trace/sdk';
 *   import { instrument } from '@clanker-trace/sdk/auto';
 *
 *   const ct = new ClankerTrace({ apiKey: 'ct_xxx' });
 *   const run = await ct.startRun({ goal: 'my task' });
 *   instrument(run);  // patches OpenAI globally
 *
 *   // All openai.chat.completions.create() calls are now traced automatically
 *   const openai = new OpenAI();
 *   await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
 *   // ^ emits llm_invocation events with model, tokens, latency
 */

import type { TracedRun } from './index';

interface PatchState {
  active: boolean;
  run: TracedRun | null;
  originals: Map<string, Function>;
}

const state: PatchState = {
  active: false,
  run: null,
  originals: new Map(),
};

/**
 * Instrument a traced run with auto-patching.
 * Currently patches: OpenAI chat completions, OpenAI embeddings.
 */
export function instrument(run: TracedRun): void {
  state.run = run;
  state.active = true;
  patchOpenAI();
}

/**
 * Remove all patches and stop auto-instrumentation.
 */
export function uninstrument(): void {
  state.active = false;
  state.run = null;
  restoreOpenAI();
}

function patchOpenAI(): void {
  let openaiModule: any;
  try {
    openaiModule = require('openai');
  } catch {
    // OpenAI not installed — skip
    return;
  }

  const OpenAI = openaiModule.default || openaiModule.OpenAI || openaiModule;
  if (!OpenAI?.prototype) return;

  // Patch chat.completions.create
  try {
    const ChatCompletions = OpenAI.Chat?.Completions || getNestedProto(OpenAI, 'chat', 'completions');
    if (ChatCompletions?.prototype?.create) {
      const orig = ChatCompletions.prototype.create;
      state.originals.set('chat.completions.create', orig);

      ChatCompletions.prototype.create = async function patchedCreate(this: any, params: any, options?: any) {
        if (!state.active || !state.run) {
          return orig.call(this, params, options);
        }

        const run = state.run;
        const model = params?.model || 'unknown';
        const startTime = Date.now();

        run.emit('llm_invocation', {
          model,
          started_at: new Date().toISOString(),
          auto_instrumented: true,
          messages_count: params?.messages?.length,
          temperature: params?.temperature,
          tools_count: params?.tools?.length,
        });

        try {
          const result = await orig.call(this, params, options);
          const latency = Date.now() - startTime;

          const usage = result?.usage;
          const choice = result?.choices?.[0];
          const toolCalls = choice?.message?.tool_calls;

          run.emit('llm_invocation', {
            model: result?.model || model,
            completed: true,
            auto_instrumented: true,
            response_preview: choice?.message?.content?.slice(0, 500),
            tokens: usage?.total_tokens,
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            cost: estimateCost(model, usage?.prompt_tokens, usage?.completion_tokens),
            finish_reason: choice?.finish_reason,
            has_tool_calls: !!toolCalls,
            tool_calls_count: toolCalls?.length,
          }, { latency_ms: latency });

          // Auto-emit tool_invocation events for function calls
          if (toolCalls) {
            for (const tc of toolCalls) {
              if (tc.type === 'function' && tc.function) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
                run.emit('tool_invocation', {
                  tool_name: tc.function.name,
                  arguments: args,
                  auto_instrumented: true,
                  tool_call_id: tc.id,
                });
              }
            }
          }

          return result;
        } catch (err) {
          const latency = Date.now() - startTime;
          run.emit('llm_invocation', {
            model,
            completed: false,
            auto_instrumented: true,
            error: String(err),
          }, { latency_ms: latency, error: true });
          throw err;
        }
      };
    }
  } catch {
    // Couldn't patch chat completions — non-fatal
  }

  // Patch embeddings.create
  try {
    const Embeddings = OpenAI.Embeddings || getNestedProto(OpenAI, 'embeddings');
    if (Embeddings?.prototype?.create) {
      const orig = Embeddings.prototype.create;
      state.originals.set('embeddings.create', orig);

      Embeddings.prototype.create = async function patchedEmbeddings(this: any, params: any, options?: any) {
        if (!state.active || !state.run) {
          return orig.call(this, params, options);
        }

        const run = state.run;
        const model = params?.model || 'unknown';
        const startTime = Date.now();

        run.emit('llm_invocation', {
          model,
          type: 'embedding',
          auto_instrumented: true,
          started_at: new Date().toISOString(),
        });

        try {
          const result = await orig.call(this, params, options);
          const latency = Date.now() - startTime;
          run.emit('llm_invocation', {
            model,
            type: 'embedding',
            completed: true,
            auto_instrumented: true,
            tokens: result?.usage?.total_tokens,
          }, { latency_ms: latency });
          return result;
        } catch (err) {
          const latency = Date.now() - startTime;
          run.emit('llm_invocation', {
            model,
            type: 'embedding',
            completed: false,
            auto_instrumented: true,
            error: String(err),
          }, { latency_ms: latency, error: true });
          throw err;
        }
      };
    }
  } catch {
    // Couldn't patch embeddings — non-fatal
  }
}

function restoreOpenAI(): void {
  let openaiModule: any;
  try {
    openaiModule = require('openai');
  } catch {
    return;
  }

  const OpenAI = openaiModule.default || openaiModule.OpenAI || openaiModule;
  if (!OpenAI?.prototype) return;

  for (const [path, original] of state.originals) {
    try {
      if (path === 'chat.completions.create') {
        const ChatCompletions = OpenAI.Chat?.Completions || getNestedProto(OpenAI, 'chat', 'completions');
        if (ChatCompletions?.prototype) ChatCompletions.prototype.create = original;
      } else if (path === 'embeddings.create') {
        const Embeddings = OpenAI.Embeddings || getNestedProto(OpenAI, 'embeddings');
        if (Embeddings?.prototype) Embeddings.prototype.create = original;
      }
    } catch {
      // Best-effort restore
    }
  }
  state.originals.clear();
}

function getNestedProto(cls: any, ...path: string[]): any {
  let proto = cls.prototype;
  for (const key of path) {
    if (!proto) return null;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor?.value?.constructor) {
      proto = descriptor.value.constructor.prototype;
    } else {
      return null;
    }
  }
  return proto?.constructor;
}

// Rough cost estimates for common models (per 1K tokens)
const COST_TABLE: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 0.0025, completion: 0.01 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4-turbo': { prompt: 0.01, completion: 0.03 },
  'gpt-4': { prompt: 0.03, completion: 0.06 },
  'gpt-3.5-turbo': { prompt: 0.0005, completion: 0.0015 },
  'claude-sonnet-4-5-20250929': { prompt: 0.003, completion: 0.015 },
  'claude-opus-4-6': { prompt: 0.015, completion: 0.075 },
  'claude-haiku-4-5-20251001': { prompt: 0.0008, completion: 0.004 },
};

function estimateCost(model: string, promptTokens?: number, completionTokens?: number): number | undefined {
  const rates = COST_TABLE[model];
  if (!rates || !promptTokens) return undefined;
  return (promptTokens / 1000) * rates.prompt + ((completionTokens || 0) / 1000) * rates.completion;
}
