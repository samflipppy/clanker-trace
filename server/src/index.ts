import express, { type Express } from 'express';
import cors from 'cors';
import compression from 'compression';
import type Database from 'better-sqlite3';
import { createDatabase } from './db/schema';
import { EventStore } from './db/store';
import { authMiddleware, generateApiKey, hashApiKey } from './middleware/auth';
import { createIngestRouter } from './routes/ingest';
import { createQueryRouter } from './routes/query';

export function createApp(dbPath?: string): { app: Express; db: Database.Database; store: EventStore } {
  const db = createDatabase(dbPath);
  const store = new EventStore(db);
  const app = express();

  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  // Health check (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Admin endpoint: create a tenant and get an API key
  app.post('/admin/tenants', (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) {
      res.status(400).json({ error: 'id and name are required' });
      return;
    }
    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    store.createTenant(id, name, keyHash);
    res.status(201).json({ id, name, api_key: apiKey });
  });

  // Authenticated routes
  const auth = authMiddleware(store);

  // Ingestion API
  app.use('/v1/ingest', auth, createIngestRouter(store));

  // Query API
  app.use('/v1/query', auth, createQueryRouter(store));

  return { app, db, store };
}

if (require.main === module) {
  const port = process.env.PORT || 3100;
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`Clanker Trace server listening on port ${port}`);
  });
}
