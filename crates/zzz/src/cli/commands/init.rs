//! `zzz init` — initialize `~/.zzz/`.
//!
//! State directory layout (from `zzz/CLAUDE.md` §"Zzz App Directory"):
//! ```text
//! ~/.zzz/
//!   config.json     — daemon config (port)
//!   state/          — persistent data (completions, workspaces.json)
//!   cache/          — regenerable data, safe to delete
//!   run/daemon.json — PID, port, version (ephemeral)
//! ```
//! The TS reference at `src/lib/zzz/commands/init.ts` creates the
//! directory and a default `config.json`; the config schema is at
//! `src/lib/zzz/cli_config.ts`. Unlike the TS reference (which errors when
//! `config.json` already exists), this port is idempotent: it `mkdir -p`s
//! the subdirectories and only writes `config.json` when absent, so re-runs
//! are safe and never clobber a configured port.

use std::fs;

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle as dl;

/// State subdirectories created under `~/.zzz/`. `run/` also holds the
/// ephemeral `daemon.json`; `daemon start` creates it on demand, but
/// `init` makes it up front so the layout is complete after a fresh init.
const STATE_SUBDIRS: &[&str] = &["state", "cache", "run"];

/// Initialize zzz configuration (`~/.zzz/`).
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `InitArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "init")]
pub struct Init {
    /// daemon port to record in `config.json` (default 4460)
    #[argh(option)]
    pub port: Option<u16>,
}

/// Handle `zzz init`.
///
/// Reference: `src/lib/zzz/commands/init.ts`.
pub fn cmd_init(args: &Init) -> Result<(), CliError> {
    let zzz_dir = dl::zzz_dir()?;
    for sub in STATE_SUBDIRS {
        fs::create_dir_all(zzz_dir.join(sub))?;
    }

    let config_path = dl::config_path()?;
    if config_path.exists() {
        println!("zzz already initialized at {}", zzz_dir.display());
        println!("  config: {}", config_path.display());
    } else {
        let port = args.port.unwrap_or(dl::DEFAULT_PORT);
        let config = serde_json::json!({ "zzz_config_port": port });
        let mut content =
            serde_json::to_string_pretty(&config).map_err(|e| CliError::Daemon(e.to_string()))?;
        content.push('\n');
        fs::write(&config_path, content)?;
        println!("created {}", config_path.display());
    }

    println!("zzz is ready. Run `zzz` to auto-start the daemon and open the browser.");
    Ok(())
}
