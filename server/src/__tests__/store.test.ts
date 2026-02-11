import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../db/store';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retention_days INTEGER NOT NULL DEFAULT 90
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      goal TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      total_cost REAL DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      error_message TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(tenant_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(tenant_id, status);
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      latency_ms REAL,
      error_flag INTEGER NOT NULL DEFAULT 0,
      parent_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(tenant_id, run_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(tenant_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_events_error ON events(tenant_id, error_flag) WHERE error_flag = 1;
  `);
  return db;
}

describe('EventStore', () => {
  let store: EventStore;
  const TENANT = 'test-tenant';

  beforeEach(() => {
    const db = createTestDb();
    store = new EventStore(db);
    store.createTenant(TENANT, 'Test Org', 'hash123');
  });

  describe('runs', () => {
    it('creates and retrieves a run', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        goal: 'Test task',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      expect(run.id).toBeDefined();
      expect(run.agent_id).toBe('agent-1');
      expect(run.goal).toBe('Test task');
      expect(run.status).toBe('running');

      const fetched = store.getRun(TENANT, run.id);
      expect(fetched).toEqual(run);
    });

    it('completes a run with duration calculation', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      const completed = store.completeRun(TENANT, run.id, {
        status: 'completed',
        completed_at: '2024-01-01T00:00:05.000Z',
        total_cost: 0.005,
        total_tokens: 1500,
      });

      expect(completed!.status).toBe('completed');
      expect(completed!.duration_ms).toBe(5000);
      expect(completed!.total_cost).toBe(0.005);
      expect(completed!.total_tokens).toBe(1500);
    });

    it('fails a run with error message', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      const failed = store.completeRun(TENANT, run.id, {
        status: 'failed',
        completed_at: '2024-01-01T00:00:02.000Z',
        error_message: 'Tool timeout',
      });

      expect(failed!.status).toBe('failed');
      expect(failed!.error_message).toBe('Tool timeout');
    });

    it('queries runs with filters', () => {
      store.createRun(TENANT, { agent_id: 'a1', started_at: '2024-01-01T00:00:00.000Z' });
      store.createRun(TENANT, { agent_id: 'a2', started_at: '2024-01-01T00:01:00.000Z' });
      const r3 = store.createRun(TENANT, { agent_id: 'a1', started_at: '2024-01-01T00:02:00.000Z' });
      store.completeRun(TENANT, r3.id, { status: 'failed', completed_at: '2024-01-01T00:02:05.000Z', error_message: 'err' });

      const all = store.queryRuns(TENANT, {});
      expect(all.total).toBe(3);

      const byAgent = store.queryRuns(TENANT, { agent_id: 'a1' });
      expect(byAgent.total).toBe(2);

      const failed = store.queryRuns(TENANT, { status: 'failed' });
      expect(failed.total).toBe(1);
      expect(failed.runs[0].id).toBe(r3.id);
    });

    it('returns null for non-existent run', () => {
      expect(store.getRun(TENANT, 'nonexistent')).toBeNull();
    });
  });

  describe('events', () => {
    it('inserts and retrieves events in order', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      store.insertEvent(TENANT, {
        run_id: run.id,
        agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:01.000Z',
        event_type: 'step_started',
        sequence_number: 0,
        payload: { step_name: 'analyze' },
      });

      store.insertEvent(TENANT, {
        run_id: run.id,
        agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:02.000Z',
        event_type: 'tool_invocation',
        sequence_number: 1,
        payload: { tool_name: 'search' },
        latency_ms: 150,
      });

      store.insertEvent(TENANT, {
        run_id: run.id,
        agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:03.000Z',
        event_type: 'step_completed',
        sequence_number: 2,
        latency_ms: 2000,
      });

      const events = store.getRunEvents(TENANT, run.id);
      expect(events).toHaveLength(3);
      expect(events[0].event_type).toBe('step_started');
      expect(events[1].event_type).toBe('tool_invocation');
      expect(events[2].event_type).toBe('step_completed');
      expect(events[0].sequence_number).toBe(0);
      expect(events[1].latency_ms).toBe(150);
    });

    it('batch inserts events', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      const results = store.insertEventsBatch(TENANT, [
        {
          run_id: run.id,
          agent_id: 'agent-1',
          timestamp: '2024-01-01T00:00:01.000Z',
          event_type: 'step_started',
          sequence_number: 0,
        },
        {
          run_id: run.id,
          agent_id: 'agent-1',
          timestamp: '2024-01-01T00:00:02.000Z',
          event_type: 'tool_invocation',
          sequence_number: 1,
          error_flag: true,
        },
      ]);

      expect(results).toHaveLength(2);
      const events = store.getRunEvents(TENANT, run.id);
      expect(events).toHaveLength(2);
    });

    it('filters events by type', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      store.insertEvent(TENANT, {
        run_id: run.id, agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:01.000Z',
        event_type: 'tool_invocation', sequence_number: 0,
      });
      store.insertEvent(TENANT, {
        run_id: run.id, agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:02.000Z',
        event_type: 'llm_invocation', sequence_number: 1,
      });

      const tools = store.getEventsByType(TENANT, run.id, 'tool_invocation');
      expect(tools).toHaveLength(1);
      expect(tools[0].event_type).toBe('tool_invocation');
    });

    it('retrieves error events', () => {
      const run = store.createRun(TENANT, {
        agent_id: 'agent-1',
        started_at: '2024-01-01T00:00:00.000Z',
      });

      store.insertEvent(TENANT, {
        run_id: run.id, agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:01.000Z',
        event_type: 'tool_invocation', sequence_number: 0,
      });
      store.insertEvent(TENANT, {
        run_id: run.id, agent_id: 'agent-1',
        timestamp: '2024-01-01T00:00:02.000Z',
        event_type: 'error_raised', sequence_number: 1,
        error_flag: true, payload: { message: 'timeout' },
      });

      const errors = store.getErrorEvents(TENANT, run.id);
      expect(errors).toHaveLength(1);
      expect(errors[0].event_type).toBe('error_raised');
      expect(errors[0].error_flag).toBe(true);
    });
  });

  describe('metrics', () => {
    it('computes run metrics', () => {
      const r1 = store.createRun(TENANT, { agent_id: 'a1', started_at: '2024-01-01T00:00:00.000Z' });
      store.completeRun(TENANT, r1.id, { status: 'completed', completed_at: '2024-01-01T00:00:10.000Z', total_cost: 0.01, total_tokens: 1000 });

      const r2 = store.createRun(TENANT, { agent_id: 'a1', started_at: '2024-01-01T00:01:00.000Z' });
      store.completeRun(TENANT, r2.id, { status: 'failed', completed_at: '2024-01-01T00:01:05.000Z', error_message: 'err', total_cost: 0.005, total_tokens: 500 });

      const metrics = store.getRunMetrics(TENANT);
      expect(metrics.total_runs).toBe(2);
      expect(metrics.avg_duration_ms).toBe(7500);
      expect(metrics.failure_rate).toBe(0.5);
      expect(metrics.avg_cost).toBeCloseTo(0.0075);
      expect(metrics.total_tokens).toBe(1500);
    });
  });

  describe('tenants', () => {
    it('creates and retrieves tenant by API key hash', () => {
      store.createTenant('org-2', 'Org Two', 'keyhash-abc');
      const tenant = store.getTenantByApiKeyHash('keyhash-abc');
      expect(tenant).toEqual({ id: 'org-2', name: 'Org Two' });
    });

    it('returns null for unknown API key', () => {
      expect(store.getTenantByApiKeyHash('unknown')).toBeNull();
    });
  });
});
