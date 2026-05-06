use deadpool_postgres::{Config, Pool, Runtime, SslMode};
use tokio_postgres::NoTls;

use crate::error::ServerError;

// -- Pool creation ------------------------------------------------------------

/// Create a connection pool from `DATABASE_URL`.
///
/// Parses the URL into `deadpool_postgres::Config` and builds the pool.
/// Fails fast if the URL is missing or malformed.
pub fn create_pool(database_url: &str) -> Result<Pool, ServerError> {
    let pg_config: tokio_postgres::Config = database_url
        .parse()
        .map_err(|e| ServerError::Database(format!("invalid DATABASE_URL: {e}")))?;

    let mut cfg = Config::new();
    if let Some(host) = pg_config.get_hosts().first() {
        match host {
            tokio_postgres::config::Host::Tcp(h) => cfg.host = Some(h.clone()),
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(p) => {
                cfg.host = Some(p.to_string_lossy().into_owned());
            }
        }
    }
    if let Some(port) = pg_config.get_ports().first() {
        cfg.port = Some(*port);
    }
    if let Some(user) = pg_config.get_user() {
        cfg.user = Some(user.to_owned());
    }
    if let Some(dbname) = pg_config.get_dbname() {
        cfg.dbname = Some(dbname.to_owned());
    }
    if let Some(password) = pg_config.get_password() {
        cfg.password = Some(String::from_utf8_lossy(password).into_owned());
    }
    cfg.ssl_mode = Some(SslMode::Disable);

    cfg.create_pool(Some(Runtime::Tokio1), NoTls)
        .map_err(|e| ServerError::Database(format!("failed to create pool: {e}")))
}

// -- Migrations ---------------------------------------------------------------

/// Run auth table DDL (CREATE TABLE IF NOT EXISTS).
///
/// Mirrors `fuz_app`'s auth DDL from `src/lib/auth/ddl.ts`.
/// Safe to run on every startup — all statements use IF NOT EXISTS.
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

/// Auth DDL — mirrors `fuz_app`'s `src/lib/auth/ddl.ts`.
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

CREATE TABLE IF NOT EXISTS permit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES actor(id) ON DELETE SET NULL,
  granted_by UUID REFERENCES actor(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_permit_actor ON permit(actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS permit_actor_role_active_unique
  ON permit (actor_id, role) WHERE revoked_at IS NULL;

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
";

// -- Auth queries -------------------------------------------------------------

/// Row from the `auth_session` table.
#[derive(Debug)]
pub struct AuthSessionRow {
    pub id: String,
    pub account_id: uuid::Uuid,
}

/// Row from the `account` table (fields needed for request context).
#[derive(Debug, Clone)]
pub struct AccountRow {
    pub id: uuid::Uuid,
    pub username: String,
}

/// Row from the `actor` table.
#[derive(Debug, Clone)]
pub struct ActorRow {
    pub id: uuid::Uuid,
    pub account_id: uuid::Uuid,
    pub name: String,
}

/// Row from the `permit` table (active permits only).
#[derive(Debug, Clone)]
pub struct PermitRow {
    pub id: uuid::Uuid,
    pub actor_id: uuid::Uuid,
    pub role: String,
}

/// Look up a valid (non-expired) session by its token hash.
pub async fn query_session_get_valid(
    client: &deadpool_postgres::Object,
    token_hash: &str,
) -> Result<Option<AuthSessionRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, account_id FROM auth_session WHERE id = $1 AND expires_at > NOW()",
            &[&token_hash],
        )
        .await?;

    Ok(row.map(|r| AuthSessionRow {
        id: r.get(0),
        account_id: r.get(1),
    }))
}

/// Look up an account by id.
pub async fn query_account_by_id(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<Option<AccountRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, username FROM account WHERE id = $1",
            &[account_id],
        )
        .await?;

    Ok(row.map(|r| AccountRow {
        id: r.get(0),
        username: r.get(1),
    }))
}

/// Look up an actor by account id.
pub async fn query_actor_by_account(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<Option<ActorRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, account_id, name FROM actor WHERE account_id = $1",
            &[account_id],
        )
        .await?;

    Ok(row.map(|r| ActorRow {
        id: r.get(0),
        account_id: r.get(1),
        name: r.get(2),
    }))
}

/// Look up active (non-revoked, non-expired) permits for an actor.
pub async fn query_permits_for_actor(
    client: &deadpool_postgres::Object,
    actor_id: &uuid::Uuid,
) -> Result<Vec<PermitRow>, tokio_postgres::Error> {
    let rows = client
        .query(
            "SELECT id, actor_id, role FROM permit
             WHERE actor_id = $1
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at",
            &[actor_id],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| PermitRow {
            id: r.get(0),
            actor_id: r.get(1),
            role: r.get(2),
        })
        .collect())
}

/// Row from the `api_token` table (fields needed for bearer auth).
#[derive(Debug)]
pub struct ApiTokenRow {
    pub id: String,
    pub account_id: uuid::Uuid,
}

/// Look up a valid (non-expired) API token by its blake3 hash.
///
/// Mirrors `fuz_app`'s `query_validate_api_token` from `api_token_queries.ts`.
pub async fn query_validate_api_token(
    client: &deadpool_postgres::Object,
    token_hash: &str,
) -> Result<Option<ApiTokenRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, account_id FROM api_token
             WHERE token_hash = $1
               AND (expires_at IS NULL OR expires_at > NOW())",
            &[&token_hash],
        )
        .await?;

    Ok(row.map(|r| ApiTokenRow {
        id: r.get(0),
        account_id: r.get(1),
    }))
}

/// Touch an API token — update `last_used_at` (fire-and-forget).
pub async fn query_api_token_touch(
    client: &deadpool_postgres::Object,
    token_id: &str,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            "UPDATE api_token SET last_used_at = NOW() WHERE id = $1",
            &[&token_id],
        )
        .await?;
    Ok(())
}

/// Find the account ID for the keeper role (first active keeper permit).
///
/// Used at startup to resolve the daemon token's keeper account.
/// Mirrors `fuz_app`'s `query_permit_find_account_id_for_role`.
pub async fn query_keeper_account_id(
    client: &deadpool_postgres::Object,
) -> Result<Option<uuid::Uuid>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT a.id FROM account a
             JOIN actor ac ON ac.account_id = a.id
             JOIN permit p ON p.actor_id = ac.id
             WHERE p.role = 'keeper'
               AND p.revoked_at IS NULL
               AND (p.expires_at IS NULL OR p.expires_at > NOW())
             LIMIT 1",
            &[],
        )
        .await?;

    Ok(row.map(|r| r.get(0)))
}

/// Touch a session — update `last_seen_at` and extend expiry if < 1 day remaining.
///
/// Fire-and-forget: caller should spawn this without blocking the request.
pub async fn query_session_touch(
    client: &deadpool_postgres::Object,
    token_hash: &str,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            "UPDATE auth_session
             SET last_seen_at = NOW(),
                 expires_at = CASE
                   WHEN expires_at - NOW() < INTERVAL '1 day'
                     THEN NOW() + INTERVAL '30 days'
                   ELSE expires_at
                 END
             WHERE id = $1",
            &[&token_hash],
        )
        .await?;
    Ok(())
}

/// Create a new auth session.
pub async fn query_create_session(
    client: &deadpool_postgres::Object,
    token_hash: &str,
    account_id: &uuid::Uuid,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            "INSERT INTO auth_session (id, account_id, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 days')",
            &[&token_hash, account_id],
        )
        .await?;
    Ok(())
}

/// Create an account and return the row.
pub async fn query_create_account(
    client: &deadpool_postgres::Object,
    username: &str,
    password_hash: &str,
) -> Result<AccountRow, tokio_postgres::Error> {
    let row = client
        .query_one(
            "INSERT INTO account (username, password_hash) VALUES ($1, $2)
             RETURNING id, username",
            &[&username, &password_hash],
        )
        .await?;

    Ok(AccountRow {
        id: row.get(0),
        username: row.get(1),
    })
}

/// Create an actor for an account.
pub async fn query_create_actor(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
    name: &str,
) -> Result<ActorRow, tokio_postgres::Error> {
    let row = client
        .query_one(
            "INSERT INTO actor (account_id, name) VALUES ($1, $2)
             RETURNING id, account_id, name",
            &[account_id, &name],
        )
        .await?;

    Ok(ActorRow {
        id: row.get(0),
        account_id: row.get(1),
        name: row.get(2),
    })
}

/// Grant a permit to an actor (idempotent — ON CONFLICT DO NOTHING).
pub async fn query_grant_permit(
    client: &deadpool_postgres::Object,
    actor_id: &uuid::Uuid,
    role: &str,
) -> Result<PermitRow, tokio_postgres::Error> {
    // Try insert; if already exists (active permit for same role), fetch it
    let inserted = client
        .query_opt(
            "INSERT INTO permit (actor_id, role)
             VALUES ($1, $2)
             ON CONFLICT (actor_id, role) WHERE revoked_at IS NULL
             DO NOTHING
             RETURNING id, actor_id, role",
            &[actor_id, &role],
        )
        .await?;

    if let Some(row) = inserted {
        return Ok(PermitRow {
            id: row.get(0),
            actor_id: row.get(1),
            role: row.get(2),
        });
    }

    // Already existed — fetch it
    let row = client
        .query_one(
            "SELECT id, actor_id, role FROM permit
             WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL",
            &[actor_id, &role],
        )
        .await?;

    Ok(PermitRow {
        id: row.get(0),
        actor_id: row.get(1),
        role: row.get(2),
    })
}

// -- Account management queries -----------------------------------------------

/// Account row with password hash (for login / password change).
#[derive(Debug)]
pub struct AccountWithPasswordHash {
    pub id: uuid::Uuid,
    pub username: String,
    pub password_hash: String,
}

/// Look up an account by username (case-insensitive) with password hash.
pub async fn query_account_with_password_hash(
    client: &deadpool_postgres::Object,
    username: &str,
) -> Result<Option<AccountWithPasswordHash>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, username, password_hash FROM account WHERE LOWER(username) = LOWER($1)",
            &[&username],
        )
        .await?;

    Ok(row.map(|r| AccountWithPasswordHash {
        id: r.get(0),
        username: r.get(1),
        password_hash: r.get(2),
    }))
}

/// Look up an account by ID with password hash.
pub async fn query_account_with_password_hash_by_id(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<Option<AccountWithPasswordHash>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id, username, password_hash FROM account WHERE id = $1",
            &[account_id],
        )
        .await?;

    Ok(row.map(|r| AccountWithPasswordHash {
        id: r.get(0),
        username: r.get(1),
        password_hash: r.get(2),
    }))
}

/// Delete a session by token hash.
pub async fn query_delete_session(
    client: &deadpool_postgres::Object,
    token_hash: &str,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute("DELETE FROM auth_session WHERE id = $1", &[&token_hash])
        .await?;
    Ok(())
}

/// Delete a session by token hash, scoped to an account.
///
/// Returns `true` if a row was deleted, `false` if not found.
pub async fn query_delete_session_for_account(
    client: &deadpool_postgres::Object,
    token_hash: &str,
    account_id: &uuid::Uuid,
) -> Result<bool, tokio_postgres::Error> {
    let count = client
        .execute(
            "DELETE FROM auth_session WHERE id = $1 AND account_id = $2",
            &[&token_hash, account_id],
        )
        .await?;
    Ok(count > 0)
}

/// Delete all sessions for an account.
pub async fn query_delete_all_sessions_for_account(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<u64, tokio_postgres::Error> {
    let count = client
        .execute(
            "DELETE FROM auth_session WHERE account_id = $1",
            &[account_id],
        )
        .await?;
    Ok(count)
}

/// Delete an API token by id, scoped to an account.
///
/// Returns `true` if a row was deleted (token existed and belonged to the
/// given account), `false` otherwise. Scoping to `account_id` prevents one
/// account from revoking another account's tokens.
pub async fn query_revoke_api_token_for_account(
    client: &deadpool_postgres::Object,
    token_id: &str,
    account_id: &uuid::Uuid,
) -> Result<bool, tokio_postgres::Error> {
    let count = client
        .execute(
            "DELETE FROM api_token WHERE id = $1 AND account_id = $2",
            &[&token_id, account_id],
        )
        .await?;
    Ok(count > 0)
}

/// Delete all API tokens for an account.
pub async fn query_delete_all_tokens_for_account(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<u64, tokio_postgres::Error> {
    let count = client
        .execute(
            "DELETE FROM api_token WHERE account_id = $1",
            &[account_id],
        )
        .await?;
    Ok(count)
}

/// Update an account's password hash.
pub async fn query_update_password(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
    new_password_hash: &str,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            "UPDATE account SET password_hash = $1, updated_at = NOW() WHERE id = $2",
            &[&new_password_hash, account_id],
        )
        .await?;
    Ok(())
}

/// Session row for listing (no token hash exposed).
#[derive(Debug)]
pub struct SessionListRow {
    pub id: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
}

/// List all sessions for an account (for GET /sessions).
///
/// Returns session metadata — the token hash ID is included as the
/// session identifier but the original token is never exposed.
pub async fn query_sessions_for_account(
    client: &deadpool_postgres::Object,
    account_id: &uuid::Uuid,
) -> Result<Vec<SessionListRow>, tokio_postgres::Error> {
    let rows = client
        .query(
            "SELECT id,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
             FROM auth_session
             WHERE account_id = $1
             ORDER BY created_at",
            &[account_id],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| SessionListRow {
            id: r.get(0),
            created_at: r.get(1),
            last_seen_at: r.get(2),
            expires_at: r.get(3),
        })
        .collect())
}
