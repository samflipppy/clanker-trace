import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { EventStore } from '../db/store';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): string {
  return `ct_${crypto.randomBytes(32).toString('hex')}`;
}

export function authMiddleware(store: EventStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const apiKey = authHeader.slice(7);
    const keyHash = hashApiKey(apiKey);
    const tenant = store.getTenantByApiKeyHash(keyHash);

    if (!tenant) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    req.tenantId = tenant.id;
    next();
  };
}
