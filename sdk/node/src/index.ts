import { v4 as uuidv4 } from 'uuid';

const DEFAULT_ENDPOINT = 'https://api.clankertrace.com';

export interface ClankerTraceConfig {
  endpoint?: string;
  apiKey?: string;
  agentId?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
}

/**
 * Zero-config initializer. Reads from environment variables:
 *   CLANKER_API_KEY, CLANKER_ENDPOINT, CLANKER_AGENT_ID
 *
 * Usage:
 *   const ct = init();
 *   const run = await ct.startRun({ goal: 'my task' });
 */
export function init(overrides?: Partial<ClankerTraceConfig>): ClankerTrace {
  return new ClankerTrace({
    endpoint: overrides?.endpoint,
    apiKey: overrides?.apiKey,
    agentId: overrides?.agentId,
    batchSize: overrides?.batchSize,
    flushIntervalMs: overrides?.flushIntervalMs,
    maxRetries: overrides?.maxRetries,
  });
}

export interface RunOptions {
  goal?: string;
  metadata?: Record<string, unknown>;
}

export type EventType =
  | 'run_started'
  | 'run_completed'
  | 'step_started'
  | 'step_completed'
  | 'group_started'
  | 'group_completed'
  | 'llm_invocation'
  | 'tool_invocation'
  | 'tool_response'
  | 'memory_query'
  | 'memory_response'
  | 'reasoning_step'
  | 'retry_attempt'
  | 'fallback_triggered'
  | 'error_raised'
  | 'human_intervention'
  | 'execution_paused'
  | 'execution_resumed'
  | string;

export type GroupKind =
  | 'reasoning'
  | 'tool_chain'
  | 'retry_cluster'
  | 'memory_sequence'
  | string;

interface QueuedEvent {
  run_id: string;
  agent_id: string;
  timestamp: string;
  event_type: EventType;
  sequence_number: number;
  payload?: Record<string, unknown>;
  latency_ms?: number;
  error_flag?: boolean;
  parent_event_id?: string;
}

export class ClankerTrace {
  private endpoint: string;
  private apiKey: string;
  private agentId: string;
  private batchSize: number;
  private flushIntervalMs: number;
  private maxRetries: number;
  private eventQueue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(config: ClankerTraceConfig = {}) {
    this.endpoint = (config.endpoint || process.env.CLANKER_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.CLANKER_API_KEY || '';
    this.agentId = config.agentId || process.env.CLANKER_AGENT_ID || 'default';
    this.batchSize = config.batchSize ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
    this.maxRetries = config.maxRetries ?? 3;

    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  async startRun(options: RunOptions = {}): Promise<TracedRun> {
    const startedAt = new Date().toISOString();
    const response = await this.request('POST', '/v1/ingest/runs', {
      agent_id: this.agentId,
      goal: options.goal,
      started_at: startedAt,
      metadata: options.metadata,
    });

    const run = await response.json() as { id: string };
    return new TracedRun(this, run.id, this.agentId);
  }

  /** @internal */
  async completeRun(runId: string, status: 'completed' | 'failed', error?: string, cost?: number, tokens?: number): Promise<void> {
    await this.flush();
    await this.request('PATCH', `/v1/ingest/runs/${runId}`, {
      status,
      completed_at: new Date().toISOString(),
      error_message: error,
      total_cost: cost,
      total_tokens: tokens,
    });
  }

  /** @internal */
  enqueueEvent(event: QueuedEvent): void {
    this.eventQueue.push(event);
    if (this.eventQueue.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.eventQueue.length === 0) return;
    this.flushing = true;

    const batch = this.eventQueue.splice(0, this.batchSize);
    try {
      await this.request('POST', '/v1/ingest/events/batch', { events: batch });
    } catch (err) {
      // Put events back at front of queue on failure
      this.eventQueue.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.endpoint}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        return response;
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.maxRetries) {
          await this.sleep(Math.pow(2, attempt) * 100);
        }
      }
    }

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class TracedRun {
  private sequenceNumber = 0;
  private ended = false;

  constructor(
    private tracer: ClankerTrace,
    public readonly runId: string,
    private agentId: string,
  ) {}

  emit(eventType: EventType, payload?: Record<string, unknown>, options?: {
    latency_ms?: number;
    error?: boolean;
    parent_event_id?: string;
  }): void {
    if (this.ended) {
      throw new Error('Cannot emit events on a completed run');
    }
    this.tracer.enqueueEvent({
      run_id: this.runId,
      agent_id: this.agentId,
      timestamp: new Date().toISOString(),
      event_type: eventType,
      sequence_number: this.sequenceNumber++,
      payload,
      latency_ms: options?.latency_ms,
      error_flag: options?.error,
      parent_event_id: options?.parent_event_id,
    });
  }

  async step<T>(name: string, fn: (step: TracedStep) => Promise<T>): Promise<T> {
    const stepId = uuidv4();
    const startTime = Date.now();

    this.emit('step_started', { step_name: name, step_id: stepId });

    try {
      const tracedStep = new TracedStep(this, stepId);
      const result = await fn(tracedStep);
      const latency = Date.now() - startTime;
      this.emit('step_completed', { step_name: name, step_id: stepId }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('step_completed', {
        step_name: name,
        step_id: stepId,
        error: String(err),
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }

  async trackLLM(model: string, fn: () => Promise<{ response: string; tokens?: number; cost?: number }>): Promise<{ response: string; tokens?: number; cost?: number }> {
    const startTime = Date.now();
    this.emit('llm_invocation', { model, started_at: new Date().toISOString() });

    try {
      const result = await fn();
      const latency = Date.now() - startTime;
      this.emit('llm_invocation', {
        model,
        response_preview: result.response.slice(0, 500),
        tokens: result.tokens,
        cost: result.cost,
        completed: true,
      }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('llm_invocation', {
        model,
        error: String(err),
        completed: false,
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }

  async trackTool(toolName: string, args: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown> {
    const startTime = Date.now();
    this.emit('tool_invocation', { tool_name: toolName, arguments: args });

    try {
      const result = await fn();
      const latency = Date.now() - startTime;
      this.emit('tool_response', {
        tool_name: toolName,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        success: true,
      }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('tool_response', {
        tool_name: toolName,
        error: String(err),
        success: false,
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }

  async group<T>(name: string, kind: GroupKind, fn: (group: TracedGroup) => Promise<T>): Promise<T> {
    const groupId = uuidv4();
    const startTime = Date.now();

    this.emit('group_started', { group_name: name, group_id: groupId, kind });

    try {
      const tracedGroup = new TracedGroup(this, groupId, name, kind);
      const result = await fn(tracedGroup);
      const latency = Date.now() - startTime;
      this.emit('group_completed', {
        group_name: name,
        group_id: groupId,
        kind,
        event_count: tracedGroup.eventCount,
      }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('group_completed', {
        group_name: name,
        group_id: groupId,
        kind,
        error: String(err),
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }

  async complete(options?: { cost?: number; tokens?: number }): Promise<void> {
    this.ended = true;
    await this.tracer.completeRun(this.runId, 'completed', undefined, options?.cost, options?.tokens);
  }

  async fail(error: string, options?: { cost?: number; tokens?: number }): Promise<void> {
    this.ended = true;
    await this.tracer.completeRun(this.runId, 'failed', error, options?.cost, options?.tokens);
  }
}

export class TracedStep {
  constructor(
    private run: TracedRun,
    public readonly stepId: string,
  ) {}

  emit(eventType: EventType, payload?: Record<string, unknown>, options?: {
    latency_ms?: number;
    error?: boolean;
  }): void {
    this.run.emit(eventType, payload, {
      ...options,
      parent_event_id: this.stepId,
    });
  }
}

export class TracedGroup {
  private _eventCount = 0;

  constructor(
    private run: TracedRun,
    public readonly groupId: string,
    public readonly name: string,
    public readonly kind: GroupKind,
  ) {}

  get eventCount(): number {
    return this._eventCount;
  }

  emit(eventType: EventType, payload?: Record<string, unknown>, options?: {
    latency_ms?: number;
    error?: boolean;
  }): void {
    this._eventCount++;
    this.run.emit(eventType, payload, {
      ...options,
      parent_event_id: this.groupId,
    });
  }

  async trackLLM(model: string, fn: () => Promise<{ response: string; tokens?: number; cost?: number }>): Promise<{ response: string; tokens?: number; cost?: number }> {
    const startTime = Date.now();
    this.emit('llm_invocation', { model, started_at: new Date().toISOString() });

    try {
      const result = await fn();
      const latency = Date.now() - startTime;
      this.emit('llm_invocation', {
        model,
        response_preview: result.response.slice(0, 500),
        tokens: result.tokens,
        cost: result.cost,
        completed: true,
      }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('llm_invocation', {
        model,
        error: String(err),
        completed: false,
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }

  async trackTool(toolName: string, args: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown> {
    const startTime = Date.now();
    this.emit('tool_invocation', { tool_name: toolName, arguments: args });

    try {
      const result = await fn();
      const latency = Date.now() - startTime;
      this.emit('tool_response', {
        tool_name: toolName,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        success: true,
      }, { latency_ms: latency });
      return result;
    } catch (err) {
      const latency = Date.now() - startTime;
      this.emit('tool_response', {
        tool_name: toolName,
        error: String(err),
        success: false,
      }, { latency_ms: latency, error: true });
      throw err;
    }
  }
}
