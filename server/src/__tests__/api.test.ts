import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index';
import type { Express } from 'express';
import type Database from 'better-sqlite3';

describe('API', () => {
  let app: Express;
  let db: Database.Database;
  let apiKey: string;

  beforeEach(async () => {
    const created = createApp(':memory:');
    app = created.app;
    db = created.db;

    // Create a tenant
    const res = await request(app)
      .post('/admin/tenants')
      .send({ id: 'test-org', name: 'Test Org' });
    apiKey = res.body.api_key;
  });

  afterEach(() => {
    db.close();
  });

  describe('health', () => {
    it('returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('auth', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/v1/query/runs');
      expect(res.status).toBe(401);
    });

    it('rejects invalid API keys', async () => {
      const res = await request(app)
        .get('/v1/query/runs')
        .set('Authorization', 'Bearer invalid');
      expect(res.status).toBe(403);
    });
  });

  describe('ingestion', () => {
    it('creates a run', async () => {
      const res = await request(app)
        .post('/v1/ingest/runs')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          agent_id: 'test-agent',
          goal: 'Test goal',
          started_at: '2024-01-01T00:00:00.000Z',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.agent_id).toBe('test-agent');
      expect(res.body.status).toBe('running');
    });

    it('completes a run', async () => {
      const createRes = await request(app)
        .post('/v1/ingest/runs')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          agent_id: 'test-agent',
          started_at: '2024-01-01T00:00:00.000Z',
        });

      const res = await request(app)
        .patch(`/v1/ingest/runs/${createRes.body.id}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          status: 'completed',
          completed_at: '2024-01-01T00:00:05.000Z',
          total_cost: 0.01,
          total_tokens: 1000,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.duration_ms).toBe(5000);
    });

    it('ingests a single event', async () => {
      const runRes = await request(app)
        .post('/v1/ingest/runs')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          agent_id: 'test-agent',
          started_at: '2024-01-01T00:00:00.000Z',
        });

      const res = await request(app)
        .post('/v1/ingest/events')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          run_id: runRes.body.id,
          agent_id: 'test-agent',
          timestamp: '2024-01-01T00:00:01.000Z',
          event_type: 'tool_invocation',
          sequence_number: 0,
          payload: { tool_name: 'search', arguments: { query: 'test' } },
          latency_ms: 150,
        });

      expect(res.status).toBe(201);
      expect(res.body.event_type).toBe('tool_invocation');
    });

    it('ingests a batch of events', async () => {
      const runRes = await request(app)
        .post('/v1/ingest/runs')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          agent_id: 'test-agent',
          started_at: '2024-01-01T00:00:00.000Z',
        });

      const res = await request(app)
        .post('/v1/ingest/events/batch')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          events: [
            {
              run_id: runRes.body.id,
              agent_id: 'test-agent',
              timestamp: '2024-01-01T00:00:01.000Z',
              event_type: 'step_started',
              sequence_number: 0,
            },
            {
              run_id: runRes.body.id,
              agent_id: 'test-agent',
              timestamp: '2024-01-01T00:00:02.000Z',
              event_type: 'step_completed',
              sequence_number: 1,
              latency_ms: 1000,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.inserted).toBe(2);
    });

    it('validates event payloads', async () => {
      const res = await request(app)
        .post('/v1/ingest/events')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('query', () => {
    let runId: string;

    beforeEach(async () => {
      const runRes = await request(app)
        .post('/v1/ingest/runs')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          agent_id: 'test-agent',
          goal: 'Analyze data',
          started_at: '2024-01-01T00:00:00.000Z',
        });
      runId = runRes.body.id;

      await request(app)
        .post('/v1/ingest/events/batch')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          events: [
            { run_id: runId, agent_id: 'test-agent', timestamp: '2024-01-01T00:00:01.000Z', event_type: 'step_started', sequence_number: 0, payload: { step_name: 'fetch' } },
            { run_id: runId, agent_id: 'test-agent', timestamp: '2024-01-01T00:00:02.000Z', event_type: 'tool_invocation', sequence_number: 1, payload: { tool_name: 'api_call' }, latency_ms: 200 },
            { run_id: runId, agent_id: 'test-agent', timestamp: '2024-01-01T00:00:03.000Z', event_type: 'error_raised', sequence_number: 2, error_flag: true, payload: { message: 'timeout' } },
            { run_id: runId, agent_id: 'test-agent', timestamp: '2024-01-01T00:00:04.000Z', event_type: 'step_completed', sequence_number: 3, latency_ms: 3000 },
          ],
        });

      await request(app)
        .patch(`/v1/ingest/runs/${runId}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ status: 'completed', completed_at: '2024-01-01T00:00:05.000Z' });
    });

    it('lists runs', async () => {
      const res = await request(app)
        .get('/v1/query/runs')
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('gets a single run', async () => {
      const res = await request(app)
        .get(`/v1/query/runs/${runId}`)
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.goal).toBe('Analyze data');
    });

    it('gets run timeline', async () => {
      const res = await request(app)
        .get(`/v1/query/runs/${runId}/timeline`)
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.run.id).toBe(runId);
      expect(res.body.events).toHaveLength(4);
      expect(res.body.events[0].event_type).toBe('step_started');
    });

    it('gets events filtered by type', async () => {
      const res = await request(app)
        .get(`/v1/query/runs/${runId}/events?event_type=tool_invocation`)
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
    });

    it('gets error events', async () => {
      const res = await request(app)
        .get(`/v1/query/errors?run_id=${runId}`)
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].event_type).toBe('error_raised');
    });

    it('gets metrics', async () => {
      const res = await request(app)
        .get('/v1/query/metrics')
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.total_runs).toBe(1);
    });

    it('returns 404 for non-existent run', async () => {
      const res = await request(app)
        .get('/v1/query/runs/nonexistent')
        .set('Authorization', `Bearer ${apiKey}`);

      expect(res.status).toBe(404);
    });
  });
});
