import { Request, Response, NextFunction } from 'express';
import { EventStore } from '../db/store';

/**
 * Middleware that checks credit balance before allowing event ingestion.
 * Runs can always be started/completed (free), but events cost credits.
 * Batch events are charged per event in the batch.
 */
export function creditGateMiddleware(store: EventStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      next();
      return;
    }

    // Run lifecycle endpoints are free — only event ingestion costs credits
    if (req.path.startsWith('/runs') && !req.path.includes('/events')) {
      next();
      return;
    }

    // Calculate cost based on request type
    let eventCount = 1;
    if (req.path === '/events/batch' && req.body?.events) {
      eventCount = req.body.events.length;
    }

    const effective = store.getEffectiveBalance(tenantId);
    if (effective < eventCount) {
      res.status(402).json({
        error: 'Insufficient credits',
        balance: effective,
        required: eventCount,
        deposit_url: '/v1/billing/deposit',
        message: `Need ${eventCount} credits but only ${effective} remaining. Deposit more at /v1/billing/deposit`,
      });
      return;
    }

    // Deduct credits
    const consumed = store.consumeCredits(tenantId, eventCount);
    if (!consumed) {
      res.status(402).json({ error: 'Credit deduction failed — race condition, retry' });
      return;
    }

    // Attach consumption info to response headers for SDK visibility
    res.setHeader('X-Credits-Consumed', String(eventCount));
    res.setHeader('X-Credits-Remaining', String(store.getEffectiveBalance(tenantId)));

    next();
  };
}
