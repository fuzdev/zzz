//! CLI module — argh-derived subcommand surface.
//!
//! Mirrors the Deno-side layout at `src/lib/zzz/cli/`. The `TopLevel` +
//! `Subcommand` enum live in `main.rs` (per the fuz reference at
//! `private_fuz/crates/fuz/src/main.rs`); each command's `FromArgs` struct
//! and `cmd_*` handler live under `commands/` (per the `tsv_cli` reference
//! at `private_tsv/crates/tsv_cli/src/cli/commands/`).

pub mod commands;
