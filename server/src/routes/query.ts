import { Router, Request, Response } from 'express';
import { EventStore, EventRecord, RunFilter } from '../db/store';

interface TimelineGroup {
  group_id: string;
  name: string;
  kind: string;
  latency_ms?: number;
  error: boolean;
  event_count: number;
  events: EventRecord[];
}

interface GroupedTimeline {
  groups: TimelineGroup[];
  ungrouped: EventRecord[];
}

function buildGroupedTimeline(events: EventRecord[]): GroupedTimeline {
  const groupMap = new Map<string, TimelineGroup>();
  const ungrouped: EventRecord[] = [];
  const groupChildIds = new Set<string>();

  // First pass: identify group_started events to build group containers
  for (const evt of events) {
    if (evt.event_type === 'group_started' && evt.payload?.group_id) {
      const gid = evt.payload.group_id as string;
      groupMap.set(gid, {
        group_id: gid,
        name: (evt.payload.group_name as string) || 'Unnamed Group',
        kind: (evt.payload.kind as string) || 'custom',
        error: false,
        event_count: 0,
        events: [],
      });
    }
  }

  // Second pass: assign events to groups and collect completion metadata
  for (const evt of events) {
    if (evt.event_type === 'group_started' || evt.event_type === 'group_completed') {
      const gid = evt.payload?.group_id as string;
      if (evt.event_type === 'group_completed' && gid && groupMap.has(gid)) {
        const g = groupMap.get(gid)!;
        g.latency_ms = evt.latency_ms;
        g.error = evt.error_flag;
        g.event_count = (evt.payload?.event_count as number) || g.events.length;
      }
      groupChildIds.add(evt.event_id);
      continue;
    }

    if (evt.parent_event_id && groupMap.has(evt.parent_event_id)) {
      groupMap.get(evt.parent_event_id)!.events.push(evt);
      groupChildIds.add(evt.event_id);
    } else {
      ungrouped.push(evt);
    }
  }

  return {
    groups: Array.from(groupMap.values()),
    ungrouped,
  };
}

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

    if (req.query.grouped === 'true') {
      const grouped = buildGroupedTimeline(events);
      res.json({ run, events, ...grouped });
      return;
    }

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

  // --- Agent-facing convenience endpoints ---
  // These are designed for agents to self-query their own execution history.

  // Get the most recent run (agent asks: "did my last run fail?")
  router.get('/runs/latest', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const agentId = req.query.agent_id as string | undefined;
    const run = store.getLatestRun(tenantId, agentId);
    if (!run) {
      res.status(404).json({ error: 'No runs found' });
      return;
    }
    res.json(run);
  });

  // Get agent health status (agent asks: "how am I doing?")
  router.get('/agent/:agentId/status', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const { agentId } = req.params;
    const status = store.getAgentStatus(tenantId, agentId);
    res.json({
      agent_id: agentId,
      healthy: status.recent_failure_count === 0,
      ...status,
    });
  });

  return router;
}
