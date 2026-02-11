import Database from 'better-sqlite3';
import path from 'path';

export function createDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || path.join(process.cwd(), 'clanker-trace.db');
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);
  return db;
}

function initializeSchema(db: Database.Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(tenant_id, started_at);

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
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(tenant_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(tenant_id, agent_id);

    CREATE TABLE IF NOT EXISTS credits (
      tenant_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      total_deposited INTEGER NOT NULL DEFAULT 0,
      total_consumed INTEGER NOT NULL DEFAULT 0,
      free_tier_remaining INTEGER NOT NULL DEFAULT 10000,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      stripe_payment_intent_id TEXT,
      deposit_address TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant ON credit_transactions(tenant_id, created_at);
  `);
}
