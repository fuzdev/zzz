//! Queries against the `actor` and `role_grant` tables.

/// Row from the `actor` table.
#[derive(Debug, Clone)]
pub struct ActorRow {
    pub id: uuid::Uuid,
    pub account_id: uuid::Uuid,
    pub name: String,
}

/// Row from the `role_grant` table (active role grants only).
#[derive(Debug, Clone)]
pub struct RoleGrantRow {
    pub id: uuid::Uuid,
    pub actor_id: uuid::Uuid,
    pub role: String,
}

/// Look up an actor by account id.
pub async fn query_actor_by_account(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Look up active (non-revoked, non-expired) role grants for an actor.
pub async fn query_role_grants_for_actor(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    actor_id: &uuid::Uuid,
) -> Result<Vec<RoleGrantRow>, tokio_postgres::Error> {
    let rows = client
        .query(
            "SELECT id, actor_id, role FROM role_grant
             WHERE actor_id = $1
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at",
            &[actor_id],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|r| RoleGrantRow {
            id: r.get(0),
            actor_id: r.get(1),
            role: r.get(2),
        })
        .collect())
}

/// Create an actor for an account.
pub async fn query_create_actor(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
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

/// Create a role grant for an actor (idempotent — ON CONFLICT DO NOTHING).
pub async fn query_create_role_grant(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    actor_id: &uuid::Uuid,
    role: &str,
) -> Result<RoleGrantRow, tokio_postgres::Error> {
    // Try insert; if already exists (active role grant for same role), fetch it
    let inserted = client
        .query_opt(
            "INSERT INTO role_grant (actor_id, role)
             VALUES ($1, $2)
             ON CONFLICT (actor_id, role) WHERE revoked_at IS NULL
             DO NOTHING
             RETURNING id, actor_id, role",
            &[actor_id, &role],
        )
        .await?;

    if let Some(row) = inserted {
        return Ok(RoleGrantRow {
            id: row.get(0),
            actor_id: row.get(1),
            role: row.get(2),
        });
    }

    let row = client
        .query_one(
            "SELECT id, actor_id, role FROM role_grant
             WHERE actor_id = $1 AND role = $2 AND revoked_at IS NULL",
            &[actor_id, &role],
        )
        .await?;

    Ok(RoleGrantRow {
        id: row.get(0),
        actor_id: row.get(1),
        role: row.get(2),
    })
}

/// Find the account id for the keeper role (first active keeper role grant).
///
/// Used at startup to resolve the daemon token's keeper account.
/// Mirrors `fuz_app`'s `query_role_grant_find_account_id_for_role`.
pub async fn query_keeper_account_id(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Option<uuid::Uuid>, tokio_postgres::Error> {
    let row = client
        .query_opt(
            "SELECT a.id FROM account a
             JOIN actor ac ON ac.account_id = a.id
             JOIN role_grant p ON p.actor_id = ac.id
             WHERE p.role = 'keeper'
               AND p.revoked_at IS NULL
               AND (p.expires_at IS NULL OR p.expires_at > NOW())
             LIMIT 1",
            &[],
        )
        .await?;

    Ok(row.map(|r| r.get(0)))
}
