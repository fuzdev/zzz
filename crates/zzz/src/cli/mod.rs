//! CLI module — argh-derived subcommand surface.
//!
//! Mirrors the Deno-side layout at `src/lib/zzz/cli/`. The `TopLevel` +
//! `Subcommand` enum live in `main.rs`; each command's `FromArgs` struct
//! and `cmd_*` handler live under `commands/`.

pub mod commands;
