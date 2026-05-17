//! Audit log emission.
//!
//! Mirrors `fuz_app`'s `auth/audit_emitter.ts`. The bound [`AuditEmitter`]
//! closes over the DB pool plus a mutable listener chain, so every
//! `audit.emit(...)` site:
//!
//! 1. Spawns a `tokio::task` that INSERTs the row via the captured pool
//!    (rollback-resilient — audit rows persist even when the request
//!    transaction rolls back).
//! 2. On successful insert, fans out the materialized row to every
//!    listener on the chain.
//!
//! Listeners are how WebSocket revocation, SSE fan-out, and any future
//! cross-cutting observers compose. The chain mirrors `fuz_app`'s
//! `on_event_chain` slot (see `fuz_app/src/lib/auth/audit_emitter.ts`).
//!
//! ## Per-call shape
//!
//! Callers pass an [`AuditLogInput`] with the same field set as `fuz_app`'s
//! TypeScript `AuditLogInput`. The four credential-gated methods PLUS
//! `password_change` carry `metadata.credential_type` — defense in depth
//! against a future loosening of the spec gate (see
//! `fuz_app/docs/security.md` §Credential-channel gating).
//!
//! ## Failure mode
//!
//! Pool-acquire failures and INSERT failures are logged at `warn` and
//! swallowed — auth flows must not break because the audit table is
//! unreachable. Same fail-open posture as `fuz_app`.

pub mod listeners;

use std::sync::Arc;

use deadpool_postgres::Pool;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::auth::CredentialType;

// -- Row + input types --------------------------------------------------------

/// Outcome of an audit event. Wire-format string matches `fuz_app`
/// (`'success' | 'failure'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditOutcome {
    Success,
    Failure,
}

impl AuditOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
        }
    }
}

/// Audit log row as materialized by the INSERT … RETURNING * call.
///
/// Mirrors `fuz_app`'s `AuditLogEvent`. Field nullability matches the table
/// DDL. Consumers iterate this through the listener chain — the type
/// isn't currently sent on the wire (no `Serialize` derive); add one if a
/// future SSE / WS broadcaster materializes.
///
/// `#[allow(dead_code)]` on the struct because every listener reads only a
/// few fields; the others are public API surface that future listeners
/// (admin audit log streaming, etc.) will reach for.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct AuditLogEvent {
    pub id: uuid::Uuid,
    pub seq: i32,
    pub event_type: String,
    pub outcome: String,
    pub actor_id: Option<uuid::Uuid>,
    pub account_id: Option<uuid::Uuid>,
    pub target_account_id: Option<uuid::Uuid>,
    pub target_actor_id: Option<uuid::Uuid>,
    pub ip: Option<String>,
    /// ISO 8601 UTC string for wire parity with the Deno backend.
    pub created_at: String,
    /// JSONB metadata as a parsed JSON value (read via the `::text`
    /// cast in `RETURNING` to avoid pulling tokio-postgres's
    /// `with-serde_json-1` feature flag into the workspace).
    pub metadata: Option<Value>,
}

/// Input for [`AuditEmitter::emit`]. Mirrors `fuz_app`'s `AuditLogInput`.
///
/// `outcome` defaults to [`AuditOutcome::Success`] at the SQL level so
/// callers that don't care can leave it `None`.
#[derive(Debug, Clone)]
pub struct AuditLogInput {
    pub event_type: &'static str,
    pub outcome: Option<AuditOutcome>,
    pub actor_id: Option<uuid::Uuid>,
    pub account_id: Option<uuid::Uuid>,
    pub target_account_id: Option<uuid::Uuid>,
    pub target_actor_id: Option<uuid::Uuid>,
    pub ip: Option<String>,
    pub metadata: Option<Value>,
}

/// Listener callback shape. Runs synchronously on the audit emit task
/// after the INSERT succeeds. Per-listener panics would propagate;
/// listener bodies should be cheap and infallible.
pub type AuditListener = Box<dyn Fn(&AuditLogEvent) + Send + Sync>;

// -- Emitter ------------------------------------------------------------------

/// Bound audit-emit capability. One instance lives on [`crate::handlers::App`].
///
/// Constructed once in `main` (see [`AuditEmitter::new`]) and wrapped in
/// `Arc`. Listeners are appended at server-assembly time after the rest of
/// `App` is built (e.g. socket-revocation listeners that capture `Arc<App>`).
pub struct AuditEmitter {
    pool: Pool,
    listeners: RwLock<Vec<AuditListener>>,
}

impl AuditEmitter {
    pub fn new(pool: Pool) -> Self {
        Self {
            pool,
            listeners: RwLock::new(Vec::new()),
        }
    }

    /// Append a listener to the chain.
    ///
    /// Listeners are typically registered once at startup, before the
    /// listener vec is read concurrently from emit tasks. The `RwLock`
    /// supports late registration regardless.
    pub fn add_listener(&self, listener: AuditListener) {
        self.listeners.write().push(listener);
    }

    /// Spawn a fire-and-forget audit write via the captured pool.
    ///
    /// Returns a `JoinHandle<()>` the caller can push onto a pending-effects
    /// queue (RPC dispatch via `perform_action`) or `.await` directly (REST
    /// handlers that want the row visible by response time). Errors are
    /// logged and swallowed inside the spawned task; awaiting the handle
    /// never sees a write failure.
    ///
    /// Listeners run inside the spawned task after the INSERT succeeds.
    /// Listener throws are caught by the wrapper closure (panics propagate;
    /// listener bodies should be infallible).
    pub fn emit(self: &Arc<Self>, input: AuditLogInput) -> JoinHandle<()> {
        let emitter = Arc::clone(self);
        tokio::spawn(async move {
            emitter.write_and_notify(input).await;
        })
    }

    async fn write_and_notify(&self, input: AuditLogInput) {
        let client = match self.pool.get().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, event_type = input.event_type, "audit log pool error");
                return;
            }
        };

        let outcome = input.outcome.unwrap_or(AuditOutcome::Success).as_str();
        let metadata_json = input
            .metadata
            .as_ref()
            .map(Value::to_string);

        // `metadata::text` round-trips through the SQL layer as `text`,
        // which tokio-postgres can decode without the
        // `with-serde_json-1` feature. Parsed back into `serde_json::Value`
        // on this side.
        // tokio-postgres infers each `$N` parameter's wire type from the
        // surrounding SQL. A bare `$8::jsonb` makes it expect the JSONB
        // binary format, which `Option<String>` can't satisfy without the
        // `with-serde_json-1` feature on the workspace crate. The
        // double-cast `$8::text::jsonb` pins the parameter at TEXT (which
        // every standard `Option<String>` serializes to) and lets Postgres
        // do the text → jsonb conversion server-side. Same trick on the
        // `RETURNING metadata::text` side keeps reads off the JSONB
        // binary format, so we never have to enable the feature.
        let row = client
            .query_opt(
                "INSERT INTO audit_log
                   (event_type, outcome, actor_id, account_id,
                    target_account_id, target_actor_id, ip, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
                 RETURNING id, seq, event_type, outcome, actor_id,
                           account_id, target_account_id, target_actor_id,
                           ip,
                           to_char(created_at AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                           metadata::text",
                &[
                    &input.event_type,
                    &outcome,
                    &input.actor_id,
                    &input.account_id,
                    &input.target_account_id,
                    &input.target_actor_id,
                    &input.ip,
                    &metadata_json,
                ],
            )
            .await;

        let row = match row {
            Ok(Some(r)) => r,
            Ok(None) => {
                tracing::warn!(
                    event_type = input.event_type,
                    "audit log insert returned no row"
                );
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, event_type = input.event_type, "audit log insert failed");
                return;
            }
        };

        let metadata_text: Option<String> = row.get(10);
        let metadata = metadata_text.and_then(|s| serde_json::from_str(&s).ok());

        let event = AuditLogEvent {
            id: row.get(0),
            seq: row.get(1),
            event_type: row.get(2),
            outcome: row.get(3),
            actor_id: row.get(4),
            account_id: row.get(5),
            target_account_id: row.get(6),
            target_actor_id: row.get(7),
            ip: row.get(8),
            created_at: row.get(9),
            metadata,
        };

        self.notify(&event);
    }

    /// Fan out an audit row to every listener on the chain.
    ///
    /// Currently only called from inside the emit task after a successful
    /// insert. Exposed for future in-transaction emit sites (mirrors
    /// `AuditEmitter.notify` in `fuz_app`).
    pub fn notify(&self, event: &AuditLogEvent) {
        let listeners = self.listeners.read();
        for listener in listeners.iter() {
            listener(event);
        }
    }
}

// -- Metadata builders --------------------------------------------------------

/// Build a `metadata.credential_type` JSON value for the five gated audit
/// events. Returns `null` when no credential was resolved (defensive — the
/// gated methods always run on an authenticated request, so `Some` is the
/// hot path).
pub fn credential_type_value(credential_type: Option<CredentialType>) -> Value {
    credential_type
        .map(CredentialType::name)
        .map_or(Value::Null, |s| Value::String(s.to_owned()))
}
