//! Queries against the `auth_session` table.

/// Row from the `auth_session` table.
#[derive(Debug)]
pub struct AuthSessionRow {
    pub account_id: uuid::Uuid,
}

/// Session row for listing (no token hash exposed).
#[derive(Debug)]
pub struct SessionListRow {
    pub id: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
}

/// Look up a valid (non-expired) session by its token hash.
pub async fn query_session_get_valid(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    token_hash: &str,
) -> Result<Option<AuthSessionRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT account_id FROM auth_session WHERE id = $1 AND expires_at > NOW()",
            &[&token_hash],
        )
        .await?;

    Ok(row.map(|r| AuthSessionRow {
        account_id: r.get(0),
    }))
}

/// Touch a session — update `last_seen_at` and extend expiry if < 1 day remaining.
///
/// Fire-and-forget: caller should spawn this without blocking the request.
pub async fn query_session_touch(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Delete a session by token hash.
pub async fn query_delete_session(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Delete all sessions for an account, returning the deletion count.
///
/// Used by `account_session_revoke_all` and password change. Both callers
/// close WebSocket connections account-wide (not per session id), so the
/// id list isn't needed.
pub async fn query_delete_all_sessions_for_account(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
) -> Result<u64, tokio_postgres::Error> {
    client
        .execute(
            "DELETE FROM auth_session WHERE account_id = $1",
            &[account_id],
        )
        .await
}

/// List all sessions for an account (for `account_session_list`).
///
/// Returns session metadata — the token-hash id is included as the
/// session identifier but the original token is never exposed.
pub async fn query_sessions_for_account(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
) -> Result<Vec<SessionListRow>, tokio_postgres::Error> {
    // Order + limit mirror fuz_app's `query_session_list_for_account`
    // (`ORDER BY created_at DESC LIMIT 50`). Newest first; the cap protects
    // against pathological account-with-thousands-of-sessions cases.
    let rows = client
        .query(
            "SELECT id,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
             FROM auth_session
             WHERE account_id = $1
             ORDER BY created_at DESC
             LIMIT 50",
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
