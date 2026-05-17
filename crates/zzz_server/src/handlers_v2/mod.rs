//! Phase 7 Batch 5 spine-backed handlers — new signature shape.
//!
//! These modules mirror the per-domain handlers in `crate::handlers::*`
//! but with the **post-Phase-7** signature:
//! `(params: Value, ctx: ActionContext<'_>) -> Result<Value, JsonrpcError>`.
//!
//! Why a parallel module tree rather than in-place migration: the legacy
//! `/api/rpc` and `/api/ws` routes still dispatch via
//! `crate::handlers::dispatch(method, params, &Ctx)`, which reaches
//! through `Ctx.app: &App` for zzz-specific deps (`PtyManager`,
//! `FilerManager`, `ProviderManager`, workspaces map). Until the later
//! batches collapse `Ctx` into `ActionContext`, the two surfaces coexist
//! — this module hosts the spine-shaped handlers, registered into
//! `App.action_registry` via `crate::zzz_action_specs::build_*_specs`.
//!
//! Zzz-specific deps that don't exist on `ActionContext` (workspaces,
//! filer, pty) are passed in via closure capture from the
//! `zzz_action_specs::build_*` builders: the builder owns `Arc<App>`
//! and clones it into each per-spec handler closure, which then drops
//! into the new signature.

pub mod filesystem;
pub mod provider;
pub mod terminal;
pub mod workspace;
