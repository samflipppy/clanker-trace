import { Router, Request, Response } from 'express';
import { EventStore, RunFilter } from '../db/store';

export function createQueryRouter(store: EventStore): Router {
  const router = Router();

  // List runs with filters
  router.get('/runs', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const filter: RunFilter = {
      agent_id: req.query.agent_id as string | undefined,
      status: req.query.status as string | undefined,
      tool_invoked: req.query.tool_invoked as string | undefined,
      has_errors: req.query.has_errors !== undefined
        ? req.query.has_errors === 'true'
        : undefined,
      min_latency_ms: req.query.min_latency_ms
        ? Number(req.query.min_latency_ms)
        : undefined,
      max_latency_ms: req.query.max_latency_ms
        ? Number(req.query.max_latency_ms)
        : undefined,
      min_cost: req.query.min_cost
        ? Number(req.query.min_cost)
        : undefined,
      max_cost: req.query.max_cost
        ? Number(req.query.max_cost)
        : undefined,
      started_after: req.query.started_after as string | undefined,
      started_before: req.query.started_before as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    };
    const result = store.queryRuns(tenantId, filter);
    res.json(result);
  });

  // Get a single run
  router.get('/runs/:runId', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const run = store.getRun(tenantId, req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  });

  // Get run timeline (all events for a run)
  router.get('/runs/:runId/timeline', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const run = store.getRun(tenantId, req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const events = store.getRunEvents(tenantId, req.params.runId);
    res.json({ run, events });
  });

  // Get events by type for a run
  router.get('/runs/:runId/events', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const eventType = req.query.event_type as string | undefined;
    let events;
    if (eventType) {
      events = store.getEventsByType(tenantId, req.params.runId, eventType);
    } else {
      events = store.getRunEvents(tenantId, req.params.runId);
    }
    res.json({ events });
  });

  // Get error events
  router.get('/errors', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const runId = req.query.run_id as string | undefined;
    const errors = store.getErrorEvents(tenantId, runId);
    res.json({ errors });
  });

  // Get metrics
  router.get('/metrics', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const agentId = req.query.agent_id as string | undefined;
    const metrics = store.getRunMetrics(tenantId, agentId);
    res.json(metrics);
  });

  return router;
}
