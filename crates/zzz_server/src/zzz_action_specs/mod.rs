//! Per-domain `ActionSpec` builders for zzz's spine-backed dispatch.
//!
//! Each builder takes the consumer-side deps (`Arc<App>`, plus optional
//! spine deps like `Arc<AuditEmitter>` when the handler emits audit
//! rows), produces a `Vec<ActionSpec>` that `main.rs` concatenates into
//! the `ActionRegistry::compile(...)` input.
//!
//! Each builder registers the zzz-specific handlers in `crate::handlers::*`
//! (`core`, `project`, `filesystem`, `media`, `job`, `terminal`, `provider`)
//! into the
//! `ActionRegistry`.

pub mod core;
pub mod filesystem;
pub mod job;
pub mod media;
pub mod project;
pub mod provider;
pub mod terminal;

pub use core::build_core_specs;
pub use filesystem::build_filesystem_specs;
pub use job::build_job_specs;
pub use media::build_media_specs;
pub use project::build_project_specs;
pub use provider::build_provider_specs;
pub use terminal::build_terminal_specs;

/// Every production zzz-owned [`ActionSpec`](fuz_actions::ActionSpec), in
/// registry-composition order.
///
/// The aggregation point `run_app` folds into `ActionRegistry::compile` after
/// the protocol + `fuz_auth` adapter sets. No `_testing_*` spec is here: those
/// are the `testing_zzzd` binary's, mounted through its
/// `extra_action_specs_factory`.
///
/// Exists so the permissive-surface census below sees the whole owned surface
/// structurally — a new domain builder wired here is censused automatically
/// rather than needing the test to be remembered.
///
/// Every one but the public `ping` is **account-grain** (`account: required`,
/// `actor: none`, [`fuz_auth::AuthSpec::account_grain`]), like its TS spec in
/// `src/lib/action_specs.ts`: zzz's domain belongs to the account — terminals
/// and jobs are owned by it, and no handler reads an actor. The census below
/// holds the rule; the `action_manifest` cross suite holds each spec to its
/// TS twin.
pub fn build_zzz_owned_specs(
    app: &std::sync::Arc<crate::handlers::App>,
) -> Vec<fuz_actions::ActionSpec> {
    let mut specs = build_core_specs(std::sync::Arc::clone(app));
    specs.extend(build_project_specs(std::sync::Arc::clone(app)));
    specs.extend(build_filesystem_specs(std::sync::Arc::clone(app)));
    specs.extend(build_media_specs(std::sync::Arc::clone(app)));
    specs.extend(build_job_specs(std::sync::Arc::clone(app)));
    specs.extend(build_terminal_specs(std::sync::Arc::clone(app)));
    specs.extend(build_provider_specs(std::sync::Arc::clone(app)));
    specs
}

/// The permissive-credential census — zzz's half of the spine's
/// `Any`-credential surface, readable in one place (the counterpart of
/// `fuz_auth::action_auth::any_credential_surface`, the `fuz_cell_actions`
/// census, and the other spine servers' censuses).
///
/// The whole set is `CredentialGate::Any` today, deliberately. Many of these
/// specs are machine-capability *mutations* — `diskfile_update`,
/// `diskfile_create`, `diskfile_delete`, `directory_create`, the
/// `terminal_*` verbs, `project_open` / `project_close`, `repo_focus` /
/// `repo_unfocus`, and `completion_create` — and they
/// are the largest permissive surface in the ecosystem. That is a recorded
/// **open posture**, not an omission: zzz is a local-first garage on a
/// loopback-fixed bind where "any zzz credential carries local-user authority"
/// is defensible, and every one of these actions is already within the reach
/// of any process running as the same uid. Narrowing them is a posture change
/// that needs an explicit decision — revisit if zzz grows a second account, a
/// reverse proxy, or the agent/MCP integration.
///
/// This test exists so that stays a *statement* rather than an omission — a
/// narrowing shows up as a diff against an exact (empty) list.
///
/// Beside it, the grain census: every spec zzz registers, the test-only ones
/// included, is public or account-grain ([`build_zzz_owned_specs`]).
#[cfg(test)]
mod any_credential_surface {
    use std::sync::Arc;

    /// Inert handles: a lazy pool that never connects, an empty scoped-FS
    /// allowlist, no providers configured, and a registry with no sockets.
    fn inert_app() -> Arc<crate::handlers::App> {
        let pool = fuz_db::create_pool(
            "postgres://localhost:1/census_unused",
            &fuz_db::PoolOptions::default(),
        )
        .expect("a lazy pool builds without connecting");
        Arc::new(crate::handlers::App::new(
            pool.clone(),
            crate::scoped_fs::ScopedFs::without_roots(),
            String::new(),
            vec![],
            crate::provider::ProviderManager::new(),
            Arc::new(fuz_realtime::ConnectionRegistry::new()),
            Arc::new(fuz_auth::AuditEmitter::new(pool, Arc::default())),
        ))
    }

    /// The registry's boot-time invariants hold over the protocol specs plus
    /// every zzz-owned spec, so a spec the registry refuses fails here rather
    /// than at server boot.
    #[test]
    fn the_owned_and_protocol_specs_compile_into_a_registry() {
        let app = inert_app();
        let mut specs = fuz_actions::PROTOCOL_ACTION_SPECS();
        specs.extend(super::build_zzz_owned_specs(&app));
        let count = specs.len();
        let registry = fuz_actions::ActionRegistry::compile(specs)
            .unwrap_or_else(|e| panic!("the zzz spec set must compile: {e}"));
        assert_eq!(registry.len(), count);
    }

    #[test]
    fn every_zzz_owned_spec_admits_any_credential() {
        let app = inert_app();

        let specs = super::build_zzz_owned_specs(&app);
        assert!(!specs.is_empty(), "the census must see the owned surface");

        let gated: Vec<&str> = specs
            .iter()
            .filter(|s| !s.auth.credentials.is_any())
            .map(|s| s.method)
            .collect();
        assert!(
            gated.is_empty(),
            "zzz-owned specs are all Any by decision — record a narrowing of {gated:?} here",
        );
    }

    #[test]
    fn every_zzz_owned_spec_is_public_or_account_grain() {
        let app = inert_app();

        let specs = super::build_zzz_owned_specs(&app);
        let off_grain: Vec<&str> = specs
            .iter()
            .filter(|s| {
                !s.auth.is_public()
                    && (s.auth.account != fuz_auth::AuthAxis::Required
                        || s.auth.actor != fuz_auth::AuthAxis::None)
            })
            .map(|s| s.method)
            .collect();
        assert!(
            off_grain.is_empty(),
            "zzz-owned specs are public or account-grain, like their TS specs: {off_grain:?}",
        );
    }
}
