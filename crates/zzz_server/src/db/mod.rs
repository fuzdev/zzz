//! Database access — pool creation, migrations, and per-domain query modules.
//!
//! Submodules group queries by table family so callers can navigate by
//! domain (`auth_session`, `account`, `actor` + `role_grant`, `api_token`).
//! Every query is re-exported from this module so the rest of the crate
//! keeps using `crate::db::query_*` paths.

mod account;
mod actor;
mod api_token;
mod auth;
mod migrations;

pub use account::{
    AccountRow, query_account_by_id, query_account_summary, query_account_with_password_hash,
    query_account_with_password_hash_by_id, query_create_account, query_update_password,
};
pub use actor::{
    ActorRow, RoleGrantRow, query_actor_by_account, query_create_actor, query_create_role_grant,
    query_keeper_account_id, query_role_grants_for_actor,
};
pub use api_token::{
    query_api_token_enforce_limit, query_api_token_list_for_account, query_api_token_touch,
    query_create_api_token, query_delete_all_tokens_for_account,
    query_revoke_api_token_for_account, query_validate_api_token,
};
pub use auth::{
    query_create_session, query_delete_all_sessions_for_account, query_delete_session,
    query_delete_session_for_account, query_session_get_valid, query_session_touch,
    query_sessions_for_account,
};
pub use migrations::run_migrations;

use deadpool_postgres::{Config, Pool, Runtime, SslMode};
use tokio_postgres::NoTls;

use crate::error::ServerError;

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
