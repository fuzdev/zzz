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
