import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface RunRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  goal?: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  total_cost: number;
  total_tokens: number;
  error_message?: string;
  metadata: Record<string, unknown>;
}

export interface EventRecord {
  event_id: string;
  run_id: string;
  tenant_id: string;
  agent_id: string;
  timestamp: string;
  event_type: string;
  sequence_number: number;
  payload: Record<string, unknown>;
  latency_ms?: number;
  error_flag: boolean;
  parent_event_id?: string;
}

export interface RunFilter {
  agent_id?: string;
  status?: string;
  tool_invoked?: string;
  has_errors?: boolean;
  min_latency_ms?: number;
  max_latency_ms?: number;
  min_cost?: number;
  max_cost?: number;
  started_after?: string;
  started_before?: string;
  limit?: number;
  offset?: number;
}

export interface RunMetrics {
  total_runs: number;
  avg_duration_ms: number;
  failure_rate: number;
  avg_cost: number;
  total_tokens: number;
  retry_frequency: number;
  tool_success_rate: number;
}

export class EventStore {
  constructor(private db: Database.Database) {}

  // --- Run operations ---

  createRun(tenantId: string, run: {
    agent_id: string;
    goal?: string;
    started_at: string;
    metadata?: Record<string, unknown>;
  }): RunRecord {
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, tenant_id, agent_id, goal, status, started_at, metadata)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `);
    stmt.run(id, tenantId, run.agent_id, run.goal || null, run.started_at, JSON.stringify(run.metadata || {}));
    return this.getRun(tenantId, id)!;
  }

  getRun(tenantId: string, runId: string): RunRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM runs WHERE tenant_id = ? AND id = ?
    `);
    const row = stmt.get(tenantId, runId) as any;
    return row ? this.mapRun(row) : null;
  }

  completeRun(tenantId: string, runId: string, update: {
    status: 'completed' | 'failed';
    completed_at: string;
    error_message?: string;
    total_cost?: number;
    total_tokens?: number;
  }): RunRecord | null {
    const run = this.getRun(tenantId, runId);
    if (!run) return null;

    const startTime = new Date(run.started_at).getTime();
    const endTime = new Date(update.completed_at).getTime();
    const duration_ms = endTime - startTime;

    const stmt = this.db.prepare(`
      UPDATE runs
      SET status = ?, completed_at = ?, duration_ms = ?,
          error_message = ?, total_cost = COALESCE(?, total_cost),
          total_tokens = COALESCE(?, total_tokens)
      WHERE tenant_id = ? AND id = ?
    `);
    stmt.run(
      update.status,
      update.completed_at,
      duration_ms,
      update.error_message || null,
      update.total_cost ?? null,
      update.total_tokens ?? null,
      tenantId,
      runId
    );
    return this.getRun(tenantId, runId);
  }

  queryRuns(tenantId: string, filter: RunFilter): { runs: RunRecord[]; total: number } {
    const conditions: string[] = ['r.tenant_id = ?'];
    const params: any[] = [tenantId];

    if (filter.agent_id) {
      conditions.push('r.agent_id = ?');
      params.push(filter.agent_id);
    }
    if (filter.status) {
      conditions.push('r.status = ?');
      params.push(filter.status);
    }
    if (filter.has_errors !== undefined) {
      if (filter.has_errors) {
        conditions.push("r.status = 'failed'");
      } else {
        conditions.push("r.status != 'failed'");
      }
    }
    if (filter.min_latency_ms !== undefined) {
      conditions.push('r.duration_ms >= ?');
      params.push(filter.min_latency_ms);
    }
    if (filter.max_latency_ms !== undefined) {
      conditions.push('r.duration_ms <= ?');
      params.push(filter.max_latency_ms);
    }
    if (filter.min_cost !== undefined) {
      conditions.push('r.total_cost >= ?');
      params.push(filter.min_cost);
    }
    if (filter.max_cost !== undefined) {
      conditions.push('r.total_cost <= ?');
      params.push(filter.max_cost);
    }
    if (filter.started_after) {
      conditions.push('r.started_at >= ?');
      params.push(filter.started_after);
    }
    if (filter.started_before) {
      conditions.push('r.started_at <= ?');
      params.push(filter.started_before);
    }
    if (filter.tool_invoked) {
      conditions.push(`EXISTS (
        SELECT 1 FROM events e
        WHERE e.tenant_id = r.tenant_id AND e.run_id = r.id
        AND e.event_type = 'tool_invocation'
        AND json_extract(e.payload, '$.tool_name') = ?
      )`);
      params.push(filter.tool_invoked);
    }

    const where = conditions.join(' AND ');

    const countStmt = this.db.prepare(`SELECT COUNT(*) as total FROM runs r WHERE ${where}`);
    const { total } = countStmt.get(...params) as any;

    const limit = filter.limit || 50;
    const offset = filter.offset || 0;
    const queryParams = [...params, limit, offset];

    const stmt = this.db.prepare(`
      SELECT r.* FROM runs r WHERE ${where}
      ORDER BY r.started_at DESC LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(...queryParams) as any[];
    return { runs: rows.map(r => this.mapRun(r)), total };
  }

  // --- Event operations ---

  insertEvent(tenantId: string, event: {
    run_id: string;
    agent_id: string;
    timestamp: string;
    event_type: string;
    sequence_number: number;
    payload?: Record<string, unknown>;
    latency_ms?: number;
    error_flag?: boolean;
    parent_event_id?: string;
  }): EventRecord {
    const event_id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO events (event_id, run_id, tenant_id, agent_id, timestamp, event_type,
        sequence_number, payload, latency_ms, error_flag, parent_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event_id,
      event.run_id,
      tenantId,
      event.agent_id,
      event.timestamp,
      event.event_type,
      event.sequence_number,
      JSON.stringify(event.payload || {}),
      event.latency_ms ?? null,
      event.error_flag ? 1 : 0,
      event.parent_event_id || null
    );
    return {
      event_id,
      run_id: event.run_id,
      tenant_id: tenantId,
      agent_id: event.agent_id,
      timestamp: event.timestamp,
      event_type: event.event_type,
      sequence_number: event.sequence_number,
      payload: event.payload || {},
      latency_ms: event.latency_ms,
      error_flag: event.error_flag || false,
      parent_event_id: event.parent_event_id,
    };
  }

  insertEventsBatch(tenantId: string, events: Array<{
    run_id: string;
    agent_id: string;
    timestamp: string;
    event_type: string;
    sequence_number: number;
    payload?: Record<string, unknown>;
    latency_ms?: number;
    error_flag?: boolean;
    parent_event_id?: string;
  }>): EventRecord[] {
    const insert = this.db.prepare(`
      INSERT INTO events (event_id, run_id, tenant_id, agent_id, timestamp, event_type,
        sequence_number, payload, latency_ms, error_flag, parent_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results: EventRecord[] = [];
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        const event_id = uuidv4();
        insert.run(
          event_id,
          event.run_id,
          tenantId,
          event.agent_id,
          event.timestamp,
          event.event_type,
          event.sequence_number,
          JSON.stringify(event.payload || {}),
          event.latency_ms ?? null,
          event.error_flag ? 1 : 0,
          event.parent_event_id || null
        );
        results.push({
          event_id,
          run_id: event.run_id,
          tenant_id: tenantId,
          agent_id: event.agent_id,
          timestamp: event.timestamp,
          event_type: event.event_type,
          sequence_number: event.sequence_number,
          payload: event.payload || {},
          latency_ms: event.latency_ms,
          error_flag: event.error_flag || false,
          parent_event_id: event.parent_event_id,
        });
      }
    });
    transaction();
    return results;
  }

  getRunEvents(tenantId: string, runId: string): EventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE tenant_id = ? AND run_id = ?
      ORDER BY sequence_number ASC
    `);
    const rows = stmt.all(tenantId, runId) as any[];
    return rows.map(r => this.mapEvent(r));
  }

  getEventsByType(tenantId: string, runId: string, eventType: string): EventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE tenant_id = ? AND run_id = ? AND event_type = ?
      ORDER BY sequence_number ASC
    `);
    const rows = stmt.all(tenantId, runId, eventType) as any[];
    return rows.map(r => this.mapEvent(r));
  }

  getErrorEvents(tenantId: string, runId?: string): EventRecord[] {
    if (runId) {
      const stmt = this.db.prepare(`
        SELECT * FROM events
        WHERE tenant_id = ? AND run_id = ? AND error_flag = 1
        ORDER BY sequence_number ASC
      `);
      return (stmt.all(tenantId, runId) as any[]).map(r => this.mapEvent(r));
    }
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE tenant_id = ? AND error_flag = 1
      ORDER BY timestamp DESC LIMIT 100
    `);
    return (stmt.all(tenantId) as any[]).map(r => this.mapEvent(r));
  }

  // --- Metrics ---

  getRunMetrics(tenantId: string, agentId?: string): RunMetrics {
    const conditions: string[] = ['tenant_id = ?'];
    const params: any[] = [tenantId];
    if (agentId) {
      conditions.push('agent_id = ?');
      params.push(agentId);
    }
    const where = conditions.join(' AND ');

    const statsStmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_runs,
        AVG(duration_ms) as avg_duration_ms,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) * 1.0 / MAX(COUNT(*), 1) as failure_rate,
        AVG(total_cost) as avg_cost,
        SUM(total_tokens) as total_tokens
      FROM runs WHERE ${where}
    `);
    const stats = statsStmt.get(...params) as any;

    const retryStmt = this.db.prepare(`
      SELECT COUNT(*) as retry_count FROM events
      WHERE tenant_id = ? AND event_type = 'retry_attempt'
    `);
    const retryResult = retryStmt.get(tenantId) as any;

    const toolTotalStmt = this.db.prepare(`
      SELECT COUNT(*) as total FROM events
      WHERE tenant_id = ? AND event_type = 'tool_invocation'
    `);
    const toolTotal = toolTotalStmt.get(tenantId) as any;

    const toolErrorStmt = this.db.prepare(`
      SELECT COUNT(*) as errors FROM events
      WHERE tenant_id = ? AND event_type = 'tool_invocation' AND error_flag = 1
    `);
    const toolErrors = toolErrorStmt.get(tenantId) as any;

    const toolSuccessRate = toolTotal.total > 0
      ? (toolTotal.total - toolErrors.errors) / toolTotal.total
      : 1;

    return {
      total_runs: stats.total_runs || 0,
      avg_duration_ms: Math.round(stats.avg_duration_ms || 0),
      failure_rate: stats.failure_rate || 0,
      avg_cost: stats.avg_cost || 0,
      total_tokens: stats.total_tokens || 0,
      retry_frequency: retryResult.retry_count || 0,
      tool_success_rate: toolSuccessRate,
    };
  }

  // --- Tenant operations ---

  createTenant(id: string, name: string, apiKeyHash: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO tenants (id, name, api_key_hash) VALUES (?, ?, ?)
    `);
    stmt.run(id, name, apiKeyHash);
  }

  getTenantByApiKeyHash(apiKeyHash: string): { id: string; name: string } | null {
    const stmt = this.db.prepare(`SELECT id, name FROM tenants WHERE api_key_hash = ?`);
    return (stmt.get(apiKeyHash) as any) || null;
  }

  // --- Helpers ---

  private mapRun(row: any): RunRecord {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      goal: row.goal || undefined,
      status: row.status,
      started_at: row.started_at,
      completed_at: row.completed_at || undefined,
      duration_ms: row.duration_ms ?? undefined,
      total_cost: row.total_cost || 0,
      total_tokens: row.total_tokens || 0,
      error_message: row.error_message || undefined,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private mapEvent(row: any): EventRecord {
    return {
      event_id: row.event_id,
      run_id: row.run_id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      timestamp: row.timestamp,
      event_type: row.event_type,
      sequence_number: row.sequence_number,
      payload: JSON.parse(row.payload || '{}'),
      latency_ms: row.latency_ms ?? undefined,
      error_flag: row.error_flag === 1,
      parent_event_id: row.parent_event_id || undefined,
    };
  }
}
