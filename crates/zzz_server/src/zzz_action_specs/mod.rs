//! Per-domain `ActionSpec` builders for zzz's spine-backed dispatch.
//!
//! Each builder takes the consumer-side deps (`Arc<App>`, plus optional
//! spine deps like `Arc<AuditEmitter>` when the handler emits audit
//! rows), produces a `Vec<ActionSpec>` that `main.rs` concatenates into
//! the `ActionRegistry::compile(...)` input.
//!
//! Each builder registers the zzz-specific handlers in `crate::handlers::*`
//! (`core`, `workspace`, `filesystem`, `terminal`, `provider`) into the
//! `ActionRegistry`.

pub mod core;
pub mod filesystem;
pub mod provider;
pub mod terminal;
pub mod workspace;

pub use core::{build_core_specs, build_testing_specs};
pub use filesystem::build_filesystem_specs;
pub use provider::build_provider_specs;
pub use terminal::build_terminal_specs;
pub use workspace::build_workspace_specs;

/// Every production zzz-owned [`ActionSpec`], in registry-composition order.
///
/// The aggregation point `run_app` folds into `ActionRegistry::compile` after
/// the protocol + `fuz_auth` adapter sets. Excludes [`build_testing_specs`],
/// which registers only when `enable_test_actions` is set.
///
/// Exists so the permissive-surface census below sees the whole owned surface
/// structurally — a new domain builder wired here is censused automatically
/// rather than needing the test to be remembered.
pub fn build_zzz_owned_specs(
    app: &std::sync::Arc<crate::handlers::App>,
) -> Vec<fuz_actions::ActionSpec> {
    let mut specs = build_core_specs(std::sync::Arc::clone(app));
    specs.extend(build_workspace_specs(std::sync::Arc::clone(app)));
    specs.extend(build_filesystem_specs(std::sync::Arc::clone(app)));
    specs.extend(build_terminal_specs(std::sync::Arc::clone(app)));
    specs.extend(build_provider_specs(std::sync::Arc::clone(app)));
    specs
}

/// The permissive-credential census — zzz's half of the S1 `Any` surface,
/// readable in one place (the counterpart of
/// `fuz_auth::action_auth::any_credential_surface` and the `fuz_cell_actions`,
/// visiones, and mageguild censuses).
///
/// The whole set is `CredentialGate::Any` today, deliberately. Ten of these
/// specs are machine-capability *mutations* — `diskfile_update`,
/// `diskfile_delete`, `directory_create`, the four `terminal_*` verbs,
/// `workspace_open` / `workspace_close`, and `completion_create` — and they
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
#[cfg(test)]
mod any_credential_surface {
    use std::sync::Arc;

    #[test]
    fn every_zzz_owned_spec_admits_any_credential() {
        // Inert handles: a lazy pool that never connects, an empty scoped-FS
        // allowlist, no providers configured, and a registry with no sockets.
        let pool = fuz_db::create_pool("postgres://localhost:1/census_unused")
            .expect("a lazy pool builds without connecting");
        let app = Arc::new(crate::handlers::App::new(
            pool,
            crate::scoped_fs::ScopedFs::new(vec![]),
            String::new(),
            vec![],
            crate::provider::ProviderManager::new(),
            false,
            Arc::new(fuz_realtime::ConnectionRegistry::new()),
        ));

        let specs = super::build_zzz_owned_specs(&app);
        assert!(!specs.is_empty(), "the census must see the owned surface");

        let gated: Vec<&str> = specs
            .iter()
            .filter(|s| !s.auth.credentials.is_any())
            .map(|s| s.method)
            .collect();
        assert!(
            gated.is_empty(),
            "zzz-owned specs are all Any by decision — record a narrowing of {gated:?} here and \
             in the grimoire S1 census notes",
        );
    }
}
