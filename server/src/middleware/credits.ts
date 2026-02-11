import { Request, Response, NextFunction } from 'express';
import { EventStore } from '../db/store';
import { verifyLicense } from './license';

export type BillingMode = 'local' | 'license' | 'free';

/**
 * Credit-gating middleware with three modes:
 *
 * - 'free':    No credit checks. Everything is free. Good for local dev.
 * - 'local':   Credits tracked in local SQLite. Full billing system.
 * - 'license': Credits encoded in a signed license key from billing.clankertrace.com.
 *              Self-hosted server validates the signature locally — no phone-home
 *              on each request. User's data never leaves their infra.
 */
export function creditGateMiddleware(store: EventStore, mode?: BillingMode) {
  const billingMode = mode || (process.env.CLANKER_BILLING_MODE as BillingMode) || 'free';

  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      next();
      return;
    }

    // Run lifecycle endpoints are always free
    if (req.path.startsWith('/runs') && !req.path.includes('/events')) {
      next();
      return;
    }

    // Free mode — no checks
    if (billingMode === 'free') {
      next();
      return;
    }

    let eventCount = 1;
    if (req.path === '/events/batch' && req.body?.events) {
      eventCount = req.body.events.length;
    }

    if (billingMode === 'license') {
      // Validate license key from env or header
      const licenseKey = process.env.CLANKER_LICENSE_KEY
        || req.headers['x-license-key'] as string;

      if (!licenseKey) {
        res.status(402).json({
          error: 'No license key',
          message: 'Set CLANKER_LICENSE_KEY or get one at https://billing.clankertrace.com',
        });
        return;
      }

      const license = verifyLicense(licenseKey);
      if (!license) {
        res.status(402).json({
          error: 'Invalid or expired license key',
          message: 'Renew at https://billing.clankertrace.com',
        });
        return;
      }

      // License is valid — deduct from local credit pool
      // The license encodes total credits purchased; local DB tracks consumption
      const effective = store.getEffectiveBalance(tenantId);
      if (effective < eventCount) {
        // Try to sync credits from license
        const localCredits = store.getCredits(tenantId);
        const licensedRemaining = license.credits - localCredits.total_consumed;
        if (licensedRemaining < eventCount) {
          res.status(402).json({
            error: 'License credits exhausted',
            licensed_total: license.credits,
            consumed: localCredits.total_consumed,
            remaining: Math.max(0, licensedRemaining),
            message: 'Purchase more credits at https://billing.clankertrace.com',
          });
          return;
        }
        // Top up local balance from license
        store.addCredits(tenantId, licensedRemaining - effective);
      }

      store.consumeCredits(tenantId, eventCount);
      res.setHeader('X-Credits-Consumed', String(eventCount));
      res.setHeader('X-Credits-Remaining', String(store.getEffectiveBalance(tenantId)));
      next();
      return;
    }

    // Local mode — use SQLite credit balance
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

    const consumed = store.consumeCredits(tenantId, eventCount);
    if (!consumed) {
      res.status(402).json({ error: 'Credit deduction failed — race condition, retry' });
      return;
    }

    res.setHeader('X-Credits-Consumed', String(eventCount));
    res.setHeader('X-Credits-Remaining', String(store.getEffectiveBalance(tenantId)));
    next();
  };
}
