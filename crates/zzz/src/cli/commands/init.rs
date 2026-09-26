//! `zzz init` — initialize the daemon home, `~/.zzz/`.
//!
//! Layout:
//! ```text
//! ~/.zzz/                 — daemon home (mode 0700), the daemon's working directory
//!   config.json           — CLI config (daemon port)
//!   .env                  — daemon environment (mode 0600), with a generated cookie key
//!   bootstrap_token       — one-shot admin bootstrap token (mode 0600), deleted once used,
//!                           recreated by the next `zzz init` when missing
//!   .zzz/                 — the daemon's app directory (`PUBLIC_ZZZ_DIR` default `.zzz`)
//!   static/               — the built UI (not created — copy a `gro build` here)
//!   bin/zzzd              — the daemon binary, when installed here
//!   run/daemon.json       — pid, start time, port (ephemeral)
//!   run/daemon.log        — output of an auto-started daemon
//! ```
//! Idempotent: directories are created if missing, and each file is written
//! only when absent (`create_new`), so re-runs never clobber a configured
//! port, edited env, or key. Files holding secrets are created with mode
//! `0600` in the same call, so they are never readable by others.
//!
//! The bootstrap token is the one file a re-run regularly creates: the
//! daemon deletes it once the first admin account exists, so a home whose
//! database was later dropped (or an `.env` written by hand) would otherwise
//! have no way to create an admin. A token while an admin exists is harmless —
//! the server refuses a second bootstrap.

use std::fs;
use std::io::{self, Write as _};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle as dl;

/// Initialize zzz configuration (`~/.zzz/`).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "init")]
pub struct Init {
    /// daemon port to record in `config.json`, 1-65535 (default 4460)
    #[argh(option, from_str_fn(dl::parse_port))]
    pub port: Option<u16>,
}

/// Handle `zzz init`.
pub fn cmd_init(args: &Init) -> Result<(), CliError> {
    let zzz_dir = dl::zzz_dir()?;
    if let Ok(meta) = fs::metadata(&zzz_dir) {
        // an existing home keeps its mode, but it holds secrets
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            eprintln!(
                "warning: {} is accessible to other users (mode {mode:o}) and holds secrets; consider `chmod 700 {}`",
                zzz_dir.display(),
                zzz_dir.display()
            );
        }
    }
    fuz_sys::fs::create_dir_all_mode(&zzz_dir, 0o700)?;
    for sub in [".zzz", "run"] {
        fuz_sys::fs::create_dir_all_mode(&zzz_dir.join(sub), 0o700)?;
    }

    let port = args.port.unwrap_or(dl::DEFAULT_PORT);
    let mut config = serde_json::to_string_pretty(&serde_json::json!({ "zzz_config_port": port }))
        .map_err(|e| CliError::Daemon(e.to_string()))?;
    config.push('\n');
    let config_path = zzz_dir.join("config.json");
    let config_created = create_new(&config_path, &config, 0o644)?;
    report(&config_path, config_created);
    if !config_created && let Some(port) = args.port {
        eprintln!(
            "warning: --port {port} not applied: {} already exists; edit its `zzz_config_port` instead",
            config_path.display()
        );
    }

    let env_path = zzz_dir.join(".env");
    let token_path = zzz_dir.join("bootstrap_token");
    let env_created = create_new(
        &env_path,
        &env_template(&fuz_sys::rand::random_hex(32)),
        0o600,
    )?;
    report(&env_path, env_created);
    // Recreated whenever missing (see the module doc).
    let token_created = create_new(&token_path, &fuz_sys::rand::random_hex(32), 0o600)?;
    report(&token_path, token_created);

    println!();
    println!("next steps:");
    println!(
        "  - set DATABASE_URL in {} (and create the database, e.g. `createdb zzz`)",
        env_path.display()
    );
    let static_dir = zzz_dir.join("static");
    if !static_dir.is_dir() {
        println!(
            "  - put a UI build in {} (`gro build`, then copy `build/`), or set ZZZ_STATIC_DIR",
            static_dir.display()
        );
    }
    println!("  - run `zzz` to start the daemon and open the browser");
    // The CLI can't tell whether an admin exists (that's in the database), so
    // a recreated token's hint says when it matters rather than asserting it.
    if env_created {
        println!(
            "  - on first run, create the admin account in the browser with the token in {}",
            token_path.display()
        );
    } else if token_created {
        println!(
            "  - only if zzz has no admin account (say its database was dropped): restart a running daemon, which checks for the token at startup (`zzz daemon stop`, then `zzz`), and create the admin in the browser with the token in {}",
            token_path.display()
        );
    } else if token_path.exists() {
        println!(
            "  - if zzz has no admin account yet, create one in the browser with the token in {}",
            token_path.display()
        );
    }
    Ok(())
}

/// Create `path` with `content`, born with `mode` (`O_CREAT | O_EXCL`, so
/// no other file is clobbered and there is no window with a looser mode).
/// An existing file is left untouched. Returns whether the file was created.
fn create_new(path: &Path, content: &str, mode: u32) -> Result<bool, CliError> {
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if let Err(e) = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
    {
        // don't leave a partial file that later runs would keep
        let _ = fs::remove_file(path);
        return Err(e.into());
    }
    Ok(true)
}

fn report(path: &Path, created: bool) {
    if created {
        println!("created {}", path.display());
    } else {
        println!("exists  {}", path.display());
    }
}

/// The `~/.zzz/.env` template, with `cookie_key` as the signing key.
fn env_template(cookie_key: &str) -> String {
    format!(
        "# zzz daemon environment, read by the `zzz` CLI when it starts `zzzd`.
# Variables already set in the environment that runs `zzz` take precedence.
# Relative paths resolve against ~/.zzz, the daemon's working directory.

# PostgreSQL connection (create the database first, e.g. `createdb zzz`)
DATABASE_URL=postgres://localhost/zzz

# Cookie signing key, generated by `zzz init` (`__`-separate keys to rotate)
SECRET_FUZ_COOKIE_KEYS={cookie_key}

# One-shot token for creating the first admin account, deleted once used
FUZ_BOOTSTRAP_TOKEN_PATH=bootstrap_token

# Origins allowed to call the API
# (default: http://localhost:<port>,http://127.0.0.1:<port>)
# FUZ_ALLOWED_ORIGINS=

# App directory for zzz's own files (default: .zzz, i.e. ~/.zzz/.zzz)
# PUBLIC_ZZZ_DIR=.zzz

# Comma-separated directories zzz may read and write
# PUBLIC_ZZZ_SCOPED_DIRS=

# Built UI to serve (default: ~/.zzz/static)
# ZZZ_STATIC_DIR=

# Daemon port (default: `zzz_config_port` in ~/.zzz/config.json, else 4460)
# ZZZ_PORT=

# AI provider API keys (optional)
SECRET_ANTHROPIC_API_KEY=
SECRET_OPENAI_API_KEY=
SECRET_GOOGLE_API_KEY=
"
    )
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;
    use crate::env_file;

    #[test]
    fn create_new_never_clobbers_and_sets_mode() {
        let dir = std::env::temp_dir().join(format!(
            "zzz_init_{}_{}",
            std::process::id(),
            fuz_sys::rand::random_hex_suffix()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secret");
        assert!(create_new(&path, "first", 0o600).unwrap());
        assert!(!create_new(&path, "second", 0o600).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_template_parses_with_the_key_and_required_vars() {
        let parsed = env_file::parse_env(&env_template("k".repeat(64).as_str()));
        assert!(
            parsed.skipped_lines.is_empty(),
            "{:?}",
            parsed.skipped_lines
        );
        let parsed = parsed.vars;
        let get = |key: &str| {
            parsed
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("DATABASE_URL"), Some("postgres://localhost/zzz"));
        assert_eq!(get("SECRET_FUZ_COOKIE_KEYS"), Some("k".repeat(64).as_str()));
        assert_eq!(get("FUZ_BOOTSTRAP_TOKEN_PATH"), Some("bootstrap_token"));
        // commented-out defaults stay unset
        assert_eq!(get("FUZ_ALLOWED_ORIGINS"), None);
        assert_eq!(get("ZZZ_STATIC_DIR"), None);
    }
}
