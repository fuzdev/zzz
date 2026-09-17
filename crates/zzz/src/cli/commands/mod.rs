//! Subcommand implementations.
//!
//! Each module declares one argh `FromArgs` struct (or a parent + nested
//! enum for commands with subcommands, like `daemon`) and a `cmd_*` handler
//! function that the top-level dispatch in `main.rs` calls.

pub mod daemon;
pub mod init;
pub mod open;
pub mod status;
pub mod version;
