//! Queries against the `account` table.

/// Row from the `account` table (fields needed for request context).
#[derive(Debug, Clone)]
pub struct AccountRow {
    pub id: uuid::Uuid,
    pub username: String,
}

/// Account fields needed for `account_verify` / `SessionAccountJson`.
///
/// Mirrors `fuz_app`'s `to_session_account()` output: `id` + `username` +
/// `email` + `email_verified` + `created_at`. The full `Account` row
/// carries audit/password fields the verify response must not leak.
///
/// TODO: consolidate with `AccountRow` when more callers need the full
/// shape; today only `account_verify` needs `email`/`email_verified`/
/// `created_at` and widening `AccountRow` would ripple through the
/// auth-hot-path queries.
#[derive(Debug, Clone)]
pub struct AccountSummaryRow {
    pub id: uuid::Uuid,
    pub username: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub created_at: String,
}

/// Account row with password hash (for login / password change).
#[derive(Debug)]
pub struct AccountWithPasswordHash {
    pub id: uuid::Uuid,
    pub username: String,
    pub password_hash: String,
}

/// Look up an account by id.
pub async fn query_account_by_id(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Load the client-safe account summary for `account_verify`.
///
/// Returns `SessionAccountJson`-shaped fields: `id`, `username`, `email`,
/// `email_verified`, `created_at`. Excludes `password_hash` and audit
/// columns.
pub async fn query_account_summary(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    account_id: &uuid::Uuid,
) -> Result<Option<AccountSummaryRow>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT id,
                    username,
                    email,
                    email_verified,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
             FROM account WHERE id = $1",
            &[account_id],
        )
        .await?;

    Ok(row.map(|r| AccountSummaryRow {
        id: r.get(0),
        username: r.get(1),
        email: r.get(2),
        email_verified: r.get(3),
        created_at: r.get(4),
    }))
}

/// Look up an account by username (case-insensitive) with password hash.
pub async fn query_account_with_password_hash(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Create an account and return the row.
pub async fn query_create_account(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Update an account's password hash.
pub async fn query_update_password(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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
