import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { EventStore } from '../db/store';

const RunStartSchema = z.object({
  agent_id: z.string().min(1),
  goal: z.string().optional(),
  started_at: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

const RunCompleteSchema = z.object({
  status: z.enum(['completed', 'failed']),
  completed_at: z.string().datetime(),
  error_message: z.string().optional(),
  total_cost: z.number().optional(),
  total_tokens: z.number().int().optional(),
});

const EventSchema = z.object({
  run_id: z.string().min(1),
  agent_id: z.string().min(1),
  timestamp: z.string().datetime(),
  event_type: z.string().min(1),
  sequence_number: z.number().int().min(0),
  payload: z.record(z.unknown()).optional(),
  latency_ms: z.number().optional(),
  error_flag: z.boolean().optional(),
  parent_event_id: z.string().optional(),
});

const BatchEventsSchema = z.object({
  events: z.array(EventSchema).min(1).max(1000),
});

export function createIngestRouter(store: EventStore): Router {
  const router = Router();

  // Start a new run
  router.post('/runs', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const parsed = RunStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    const run = store.createRun(tenantId, parsed.data);
    res.status(201).json(run);
  });

  // Complete a run
  router.patch('/runs/:runId', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const { runId } = req.params;
    const parsed = RunCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    const run = store.completeRun(tenantId, runId, parsed.data);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  });

  // Ingest a single event
  router.post('/events', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const parsed = EventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    const event = store.insertEvent(tenantId, parsed.data);
    res.status(201).json(event);
  });

  // Ingest a batch of events
  router.post('/events/batch', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const parsed = BatchEventsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    const events = store.insertEventsBatch(tenantId, parsed.data.events);
    res.status(201).json({ inserted: events.length, events });
  });

  return router;
}
