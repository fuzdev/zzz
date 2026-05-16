//! Queries against the `api_token` table.

/// Row from the `api_token` table (fields needed for bearer auth).
#[derive(Debug)]
pub struct ApiTokenRow {
    pub id: String,
    pub account_id: uuid::Uuid,
}

/// Token row for listing (`ClientApiTokenJson` shape — no `token_hash`).
///
/// Mirrors `fuz_app`'s `Omit<ApiToken, 'token_hash'>`. Columns are
/// enumerated explicitly so adding a column to `api_token` doesn't
/// silently leak a hash through `SELECT *`.
#[derive(Debug)]
pub struct ApiTokenListRow {
    pub id: String,
    pub account_id: uuid::Uuid,
    pub name: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub last_used_ip: Option<String>,
    pub created_at: String,
}

/// Look up a valid (non-expired) API token by its blake3 hash.
///
/// Mirrors `fuz_app`'s `query_validate_api_token` from `api_token_queries.ts`.
pub async fn query_validate_api_token(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Insert a new API token row and return its `created_at` in RFC3339 UTC form.
///
/// `expires_at` is always `NULL` (never-expires) for now — matches `fuz_app`'s
/// `account_token_create` default, which omits `expires_at` so
/// `query_create_api_token` inserts `null`.
pub async fn query_create_api_token(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    token_id: &str,
    account_id: &uuid::Uuid,
    name: &str,
    token_hash: &str,
) -> Result<String, tokio_postgres::Error> {
    let row = client
        .query_one(
            "INSERT INTO api_token (id, account_id, name, token_hash)
             VALUES ($1, $2, $3, $4)
             RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')",
            &[&token_id, account_id, &name, &token_hash],
        )
        .await?;
    Ok(row.get(0))
}

/// List all API tokens for an account in `ClientApiTokenJson` shape.
///
/// Columns are enumerated explicitly to exclude `token_hash` — must be
/// updated if `api_token` gains new columns. Order matches `fuz_app`
/// (`created_at DESC`).
pub async fn query_api_token_list_for_account(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
) -> Result<Vec<ApiTokenListRow>, tokio_postgres::Error> {
    let rows = client
        .query(
            "SELECT id,
                    account_id,
                    name,
                    to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                    last_used_ip,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
             FROM api_token
             WHERE account_id = $1
             ORDER BY created_at DESC",
            &[account_id],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| ApiTokenListRow {
            id: r.get(0),
            account_id: r.get(1),
            name: r.get(2),
            expires_at: r.get(3),
            last_used_at: r.get(4),
            last_used_ip: r.get(5),
            created_at: r.get(6),
        })
        .collect())
}

/// Evict the oldest tokens past `max_tokens` for an account.
///
/// Mirrors `fuz_app`'s `query_api_token_enforce_limit`. The dispatcher
/// wraps `account_token_create` (and every other `side_effects: true`
/// action) in a transaction, so the `INSERT` and this DELETE commit
/// atomically — two concurrent `token_create`s can't both bypass the cap.
pub async fn query_api_token_enforce_limit(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
    max_tokens: i64,
) -> Result<u64, tokio_postgres::Error> {
    let count = client
        .execute(
            "DELETE FROM api_token
             WHERE id IN (
               SELECT id FROM api_token
               WHERE account_id = $1
               ORDER BY created_at DESC
               OFFSET $2
             )",
            &[account_id, &max_tokens],
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
) -> Result<u64, tokio_postgres::Error> {
    let count = client
        .execute("DELETE FROM api_token WHERE account_id = $1", &[account_id])
        .await?;
    Ok(count)
}
