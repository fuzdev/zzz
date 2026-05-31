//! CLI module — argh-derived subcommand surface.
//!
//! The `TopLevel` + `Subcommand` enum live in `main.rs`; each command's
//! `FromArgs` struct and `cmd_*` handler live under `commands/`.

pub mod commands;
