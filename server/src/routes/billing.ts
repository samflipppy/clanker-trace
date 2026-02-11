import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { EventStore } from '../db/store';

const DepositSchema = z.object({
  amount: z.number().int().min(1).max(100_000_000),
  currency: z.enum(['usdc']).default('usdc'),
  chain: z.enum(['base']).default('base'),
});

const EVENTS_PER_CREDIT = 1; // 1 credit = 1 event
const PRICE_PER_CREDIT_USDC = 0.0001; // $0.0001 per event

export function createBillingRouter(store: EventStore): Router {
  const router = Router();

  // Get current balance
  router.get('/balance', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const credits = store.getCredits(tenantId);
    const effective = credits.balance + credits.free_tier_remaining;

    res.json({
      balance: credits.balance,
      free_tier_remaining: credits.free_tier_remaining,
      effective_balance: effective,
      total_deposited: credits.total_deposited,
      total_consumed: credits.total_consumed,
      pricing: {
        per_event_usdc: PRICE_PER_CREDIT_USDC,
        events_per_credit: EVENTS_PER_CREDIT,
      },
    });
  });

  // Request a deposit — creates a Stripe PaymentIntent for machine payment
  // In production this calls Stripe's API; here we return the shape the agent needs
  router.post('/deposit', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const parsed = DepositSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }

    const { amount, currency, chain } = parsed.data;
    const usdcAmount = amount * PRICE_PER_CREDIT_USDC;

    // In production: const pi = await stripe.paymentIntents.create({ amount, currency: 'usdc', payment_method_types: ['crypto'] })
    // For now, generate a deterministic mock that shows the exact Stripe machine payments shape
    const paymentIntentId = `pi_${tenantId.slice(0, 8)}_${Date.now()}`;
    const depositAddress = `0x${Buffer.from(paymentIntentId).toString('hex').slice(0, 40)}`;

    res.status(201).json({
      payment_intent_id: paymentIntentId,
      deposit_address: depositAddress,
      amount_usdc: usdcAmount,
      credits: amount,
      currency,
      chain,
      status: 'awaiting_payment',
      instructions: {
        to: depositAddress,
        amount: usdcAmount.toFixed(6),
        currency: 'USDC',
        chain: 'Base',
        memo: paymentIntentId,
      },
      // Webhook will confirm and credit the account
      confirm_endpoint: `/v1/billing/confirm/${paymentIntentId}`,
    });
  });

  // Confirm a deposit (webhook from Stripe, or manual for testing)
  router.post('/confirm/:paymentIntentId', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const { paymentIntentId } = req.params;

    const creditsToAdd = req.body.credits as number;
    if (!creditsToAdd || creditsToAdd < 1) {
      res.status(400).json({ error: 'credits amount required' });
      return;
    }

    const result = store.addCredits(
      tenantId,
      creditsToAdd,
      paymentIntentId,
      req.body.deposit_address,
    );

    res.json({
      status: 'confirmed',
      credits_added: creditsToAdd,
      new_balance: result.balance,
      transaction_id: result.transaction_id,
    });
  });

  // Get transaction history
  router.get('/transactions', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const transactions = store.getCreditTransactions(tenantId, limit);
    res.json({ transactions });
  });

  // Get usage summary
  router.get('/usage', (req: Request, res: Response): void => {
    const tenantId = req.tenantId!;
    const credits = store.getCredits(tenantId);
    const metrics = store.getRunMetrics(tenantId);

    res.json({
      credits: {
        balance: credits.balance,
        free_tier_remaining: credits.free_tier_remaining,
        total_consumed: credits.total_consumed,
      },
      usage: {
        total_runs: metrics.total_runs,
        total_tokens: metrics.total_tokens,
        avg_cost_per_run: metrics.avg_cost,
        failure_rate: metrics.failure_rate,
      },
      pricing: {
        per_event_usdc: PRICE_PER_CREDIT_USDC,
      },
    });
  });

  return router;
}
