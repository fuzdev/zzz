//! `cargo xtask` — dev and build automation for the zzz workspace.
//!
//! Subcommands:
//! - `dev`        — build `zzz_server`, then run it alongside the Vite frontend
//!   (the dev backend binds `4461`; Vite serves `5173` and proxies `/api` to it).
//! - `dev-setup`  — generate `.env.development` from `.env.development.example`.
//! - `prod-setup` — generate `.env.production` from `.env.production.example`.
//! - `check-release` — the dep-graph audit (sanity check #2 of the test-binary
//!   pattern); its work is delegated to [`fuz_audit::run_check_release_cli`].
//! - no args / `help` / `-h` / `--help` — print the full subcommand list.
//! - any other subcommand — error to stderr + usage, non-zero exit.
//!
//! Dispatch and the usage text live here (not in `fuz_audit`) so bare
//! `cargo xtask` advertises zzz's own commands, not just `check-release`.
//!
//! Replaces the former Deno orchestration (`scripts/*.ts` + `deno.json`): the
//! workspace builds and runs entirely on `cargo` + `npm`/`npx`, no Deno.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::Read as _;
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Dev backend port. Vite (`5173`) proxies `/api` here; see `vite.config.ts`.
const DEV_BACKEND_PORT: u16 = 4461;
const DEV_ENV_FILE: &str = ".env.development";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("dev") => finish(run_dev()),
        Some("dev-setup") => finish(setup_env(DEV_ENV_FILE, ".env.development.example")),
        Some("prod-setup") => finish(setup_env(".env.production", ".env.production.example")),
        // The dep-graph audit is fuz_audit's; everything else (dispatch, help) is ours.
        Some("check-release") => fuz_audit::run_check_release_cli(),
        None | Some("help" | "-h" | "--help") => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("[xtask] error: unknown subcommand `{other}`\n");
            print_usage();
            ExitCode::FAILURE
        }
    }
}

/// Collapse a subcommand's [`Result`] into a process exit code, printing the
/// error to stderr on failure.
fn finish(outcome: Result<()>) -> ExitCode {
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("[xtask] error: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Print the full subcommand list. Bare `cargo xtask`, `help`, and `-h`/`--help`
/// land here so every command is discoverable — not just `check-release`.
fn print_usage() {
    println!(
        "cargo xtask — dev and build automation for the zzz workspace

usage: cargo xtask <command>

commands:
  dev            build zzz_server (port {DEV_BACKEND_PORT}), then run it alongside the Vite frontend
  dev-setup      create {DEV_ENV_FILE} from {DEV_ENV_FILE}.example
  prod-setup     create .env.production from .env.production.example
  check-release  audit that no production binary depends on fuz_testing / fuz_audit"
    );
}

/// Copy `example` → `target` (mode `0600`) when `target` is absent. Idempotent.
fn setup_env(target: &str, example: &str) -> Result<()> {
    if Path::new(target).exists() {
        println!("[xtask] {target} already exists — skipping");
        return Ok(());
    }
    if !Path::new(example).exists() {
        return Err(format!("template not found: {example}").into());
    }
    fs::copy(example, target)?;
    fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
    println!("[xtask] created {target} (chmod 600) — edit it to set keys/secrets");
    Ok(())
}

/// Build `zzz_server`, run it, wait for it to listen, then run the Vite dev
/// server. Blocks until either child exits, then tears the other down.
fn run_dev() -> Result<()> {
    if !Path::new(DEV_ENV_FILE).exists() {
        return Err(format!("{DEV_ENV_FILE} not found — run: cargo xtask dev-setup").into());
    }
    println!("[xtask] loading {DEV_ENV_FILE}");
    let mut env = parse_env_file(DEV_ENV_FILE)?;

    if let Some(token_path) = env.get("FUZ_BOOTSTRAP_TOKEN_PATH") {
        ensure_bootstrap_token(token_path)?;
    }

    // Bind the backend where the Vite proxy expects it, regardless of the
    // file's values (so a stale `.env.development` still works in dev).
    let port = DEV_BACKEND_PORT.to_string();
    env.insert("PORT".to_owned(), port.clone());
    env.insert("PUBLIC_ZZZ_SERVER_PROXIED_PORT".to_owned(), port.clone());
    env.insert(
        "PUBLIC_ZZZ_WEBSOCKET_URL".to_owned(),
        format!("ws://localhost:{DEV_BACKEND_PORT}/api/ws"),
    );

    // Child env = inherited process env, overlaid with the `.env` values.
    let mut child_env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    for (key, value) in &env {
        child_env.insert(OsString::from(key), OsString::from(value));
    }

    println!("[xtask] building zzz_server...");
    if !Command::new("cargo")
        .args(["build", "-p", "zzz_server"])
        .status()?
        .success()
    {
        return Err("cargo build -p zzz_server failed".into());
    }
    println!("[xtask] build complete");

    println!("[xtask] starting zzz_server on port {DEV_BACKEND_PORT}...");
    let mut server = Command::new("./target/debug/zzzd")
        .args(["--port", &port])
        .envs(&child_env)
        .spawn()?;

    if !wait_for_port(DEV_BACKEND_PORT, Duration::from_secs(30)) {
        let _ = server.kill();
        return Err(format!("zzz_server never listened on {DEV_BACKEND_PORT}").into());
    }
    println!("[xtask] zzz_server healthy");

    println!("[xtask] starting vite dev server...");
    let mut vite = Command::new("npx").args(["vite", "dev"]).envs(&child_env).spawn()?;

    // Ctrl+C reaches both children directly (shared process group), so they
    // shut themselves down; this loop reaps them and cleans up if one crashes.
    loop {
        if let Some(status) = server.try_wait()? {
            println!("[xtask] zzz_server exited ({status}); stopping vite");
            let _ = vite.kill();
            let _ = vite.wait();
            break;
        }
        if let Some(status) = vite.try_wait()? {
            println!("[xtask] vite exited ({status}); stopping zzz_server");
            let _ = server.kill();
            let _ = server.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// Parse a dotenv-style file into key/value pairs. Skips blank lines and `#`
/// comments; strips one layer of surrounding single or double quotes.
fn parse_env_file(path: &str) -> Result<BTreeMap<String, String>> {
    let contents = fs::read_to_string(path)?;
    let mut map = BTreeMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        map.insert(key.trim().to_owned(), value.to_owned());
    }
    Ok(map)
}

/// Create a 32-byte hex bootstrap token at `path` (mode `0600`) if absent.
fn ensure_bootstrap_token(path: &str) -> Result<()> {
    if Path::new(path).exists() {
        return Ok(());
    }
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    fs::write(path, &token)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    println!("[xtask] created bootstrap token at {path}");
    Ok(())
}

/// Poll a localhost TCP port until something accepts, or `timeout` elapses.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(&addr).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}
