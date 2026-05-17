//! Auth DDL migration runner.
//!
//! Mirrors `fuz_app`'s auth DDL from `src/lib/auth/ddl.ts`. Safe to run on
//! every startup — all statements use `IF NOT EXISTS`.

use deadpool_postgres::Pool;

use crate::error::ServerError;

/// Run auth table DDL (`CREATE TABLE IF NOT EXISTS`).
pub async fn run_migrations(pool: &Pool) -> Result<(), ServerError> {
    let client = pool
        .get()
        .await
        .map_err(|e| ServerError::Database(format!("migration connection failed: {e}")))?;

    client
        .batch_execute(AUTH_DDL)
        .await
        .map_err(|e| ServerError::Database(format!("migration failed: {e}")))?;

    tracing::info!("auth migrations complete");
    Ok(())
}

const AUTH_DDL: &str = r"
CREATE TABLE IF NOT EXISTS account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email
  ON account (LOWER(email)) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_username_ci
  ON account (LOWER(username));

CREATE TABLE IF NOT EXISTS actor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES actor(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_actor_account ON actor(account_id);

CREATE TABLE IF NOT EXISTS role_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES actor(id) ON DELETE SET NULL,
  granted_by UUID REFERENCES actor(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_role_grant_actor ON role_grant(actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS role_grant_actor_role_active_unique
  ON role_grant (actor_id, role) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_session_account ON auth_session(account_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_expires ON auth_session(expires_at);

CREATE TABLE IF NOT EXISTS bootstrap_lock (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bootstrapped BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO bootstrap_lock (id, bootstrapped)
  SELECT 1, EXISTS(SELECT 1 FROM account)
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  open_signup BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ,
  updated_by UUID
);

INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS api_token (
  id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_token_account ON api_token(account_id);

-- audit_log: mirrors fuz_app's AUDIT_LOG_SCHEMA from auth/audit_log_ddl.ts.
-- target_actor_id is parallel to target_account_id for actor-grain events
-- (role_grant_*, role_grant_offer_*); both are nullable. account_id /
-- target_account_id use ON DELETE SET NULL so deleting an account preserves
-- the audit row with the referenced id nulled out — forensic value over a
-- cascade-delete tradeoff.
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq SERIAL NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_account ON audit_log(target_account_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_actor ON audit_log(target_actor_id);
";
