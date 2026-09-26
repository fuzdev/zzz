//! `cargo xtask` — dev and build automation for the zzz workspace.
//!
//! Subcommands:
//! - `dev`        — build `zzz_server`, then run it alongside the Vite frontend
//!   (the dev backend binds `4461`; Vite serves `5173` and proxies `/api` to it).
//! - `dev-setup`  — generate `.env.development` from `.env.development.example`.
//! - `prod-setup` — generate `.env.production` from `.env.production.example`.
//!   Both fill `SECRET_FUZ_COOKIE_KEYS` with a freshly generated key.
//! - `check-release` — the dep-graph audit (sanity check #2 of the test-binary
//!   pattern); its work is delegated to [`fuz_audit::run_check_release_cli`].
//! - no args / `help` / `-h` / `--help` — print the full subcommand list.
//! - any other subcommand — error to stderr + usage, non-zero exit.
//!
//! Dispatch and the usage text live here (not in `fuz_audit`) so bare
//! `cargo xtask` advertises zzz's own commands, not just `check-release`.
//!
//! The workspace builds and runs entirely on `cargo` + `npm`, no Deno.

// The CLI's dotenv parser, compiled in here too so both read `.env` files
// identically (xtask stays std-only; no shared crate needed for one file).
#[path = "../../zzz/src/env_file.rs"]
mod env_file;

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read as _, Write as _};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;
use std::process::{Child, Command, ExitCode};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Dev backend port. Vite (`5173`) proxies `/api` here; see `vite.config.ts`.
const DEV_BACKEND_PORT: u16 = 4461;
const DEV_ENV_FILE: &str = ".env.development";
/// The Vite CLI, run directly so signals reach it (see [`run_dev`]).
const VITE_BIN: &str = "node_modules/.bin/vite";

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

/// The env var holding the cookie signing key(s).
const COOKIE_KEYS_VAR: &str = "SECRET_FUZ_COOKIE_KEYS";

/// Create `target` from `example` with a freshly generated cookie key, when
/// `target` is absent. Idempotent: an existing `target` is never touched.
fn setup_env(target: &str, example: &str) -> Result<()> {
    if Path::new(target).exists() {
        println!("[xtask] {target} already exists — skipping");
        return Ok(());
    }
    let template =
        fs::read_to_string(example).map_err(|e| format!("can't read template {example}: {e}"))?;
    let content = with_cookie_key(&template, &random_hex(32)?);
    if !create_private_file(Path::new(target), &content)? {
        println!("[xtask] {target} already exists — skipping");
        return Ok(());
    }
    println!(
        "[xtask] created {target} (mode 600, fresh {COOKIE_KEYS_VAR}) — edit it to set other secrets"
    );
    Ok(())
}

/// `template` with its `SECRET_FUZ_COOKIE_KEYS=` line set to `key` (the
/// line is appended when the template has none).
fn with_cookie_key(template: &str, key: &str) -> String {
    let assignment = format!("{COOKIE_KEYS_VAR}={key}");
    let mut replaced = false;
    let mut out = String::with_capacity(template.len() + key.len());
    for line in template.lines() {
        let is_key_line = env_file::parse_env(line)
            .vars
            .first()
            .is_some_and(|(k, _)| k == COOKIE_KEYS_VAR);
        if !is_key_line {
            out.push_str(line);
        } else if replaced {
            continue; // a duplicate assignment would override the new key
        } else {
            out.push_str(&assignment);
            replaced = true;
        }
        out.push('\n');
    }
    if !replaced {
        out.push_str(&assignment);
        out.push('\n');
    }
    out
}

/// Create `path` with `content`, born mode `0600` (`O_CREAT | O_EXCL` — no
/// clobbering, no window where the file is readable by others). Returns
/// `false` when `path` already exists.
fn create_private_file(path: &Path, content: &str) -> Result<bool> {
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(format!("can't create {}: {e}", path.display()).into()),
    };
    if let Err(e) = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = fs::remove_file(path);
        return Err(e.into());
    }
    Ok(true)
}

/// `num_bytes` from `/dev/urandom`, hex-encoded.
fn random_hex(num_bytes: usize) -> Result<String> {
    let mut bytes = vec![0u8; num_bytes];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let mut hex = String::with_capacity(num_bytes * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Build `zzz_server`, run it, wait for it to listen, then run the Vite dev
/// server. Blocks until either child exits, then stops the other.
///
/// Both children are held in [`ChildGuard`]s, so every exit path — a child
/// exiting, an error, a panic — stops the survivor with `SIGTERM` (then
/// `SIGKILL`), letting `zzzd` run its own shutdown (which reaps its
/// terminals). Vite runs as `node_modules/.bin/vite` itself — not through
/// `npx`, which doesn't forward signals — so the guard's `SIGTERM` reaches
/// it. Ctrl+C reaches both children directly (shared process group), so
/// they shut themselves down. A `SIGTERM` / `SIGKILL` sent to this process
/// alone can't be caught without a signal-handling dependency, so that path
/// leaves the children running.
///
/// The children's env is the inherited environment overlaid by
/// `.env.development`: the file is dev's source of truth and its non-blank
/// values **win** — a stale exported `DATABASE_URL` must not redirect dev
/// migrations, while a blank `KEY=` line is unset and clears nothing — with one
/// line printed per inherited variable it overrides (the key, never the
/// value). Then the forced dev ports. (The `zzz` CLI's rule for `~/.zzz/.env`
/// is the opposite: the process env wins there.)
fn run_dev() -> Result<()> {
    if !Path::new(DEV_ENV_FILE).exists() {
        return Err(format!("{DEV_ENV_FILE} not found — run: cargo xtask dev-setup").into());
    }
    let vite_bin = std::env::current_dir()?.join(VITE_BIN);
    if !vite_bin.is_file() {
        return Err(format!("{VITE_BIN} not found — run: npm install").into());
    }
    println!("[xtask] loading {DEV_ENV_FILE}");
    let parsed = env_file::parse_env(&fs::read_to_string(DEV_ENV_FILE)?);
    if !parsed.skipped_lines.is_empty() {
        let lines: Vec<String> = parsed
            .skipped_lines
            .iter()
            .map(ToString::to_string)
            .collect();
        eprintln!(
            "[xtask] warning: {DEV_ENV_FILE}: skipped line(s) {} (not `KEY=value` assignments)",
            lines.join(", ")
        );
    }
    let mut env = file_values(parsed.vars);
    for key in overridden_keys(&env, |key| std::env::var_os(key)) {
        println!("[xtask] {DEV_ENV_FILE} overrides {key} from the environment");
    }

    if let Some(token_path) = env
        .get("FUZ_BOOTSTRAP_TOKEN_PATH")
        .filter(|path| !path.trim().is_empty())
    {
        ensure_bootstrap_token(token_path)?;
    }

    // Point the frontend at the backend's port regardless of the env's
    // values (so a stale `.env.development` still works in dev).
    let port = DEV_BACKEND_PORT.to_string();
    env.insert("PUBLIC_ZZZ_SERVER_PROXIED_PORT".to_owned(), port.clone());
    env.insert(
        "PUBLIC_ZZZ_WEBSOCKET_URL".to_owned(),
        format!("ws://localhost:{DEV_BACKEND_PORT}/api/ws"),
    );

    // Child env = inherited process env, overlaid with the values above.
    let mut child_env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    for (key, value) in &env {
        child_env.insert(OsString::from(key), OsString::from(value));
    }
    // `npx` put `node_modules/.bin` on the PATH; keep that for tools vite's
    // plugins may spawn
    let bin_dir = vite_bin.parent().map(Path::to_path_buf).unwrap_or_default();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let joined =
        std::env::join_paths(std::iter::once(bin_dir).chain(std::env::split_paths(&path)))?;
    child_env.insert(OsString::from("PATH"), joined);

    println!("[xtask] building zzz_server...");
    if !Command::new("cargo")
        .args(["build", "-p", "zzz_server"])
        .status()?
        .success()
    {
        return Err("cargo build -p zzz_server failed".into());
    }
    println!("[xtask] build complete");

    if TcpListener::bind((Ipv4Addr::LOCALHOST, DEV_BACKEND_PORT)).is_err() {
        return Err(format!(
            "port {DEV_BACKEND_PORT} is already in use (a zzzd from an earlier run?)"
        )
        .into());
    }

    println!("[xtask] starting zzz_server on port {DEV_BACKEND_PORT}...");
    let mut server = ChildGuard::new(
        "zzz_server",
        Command::new("./target/debug/zzzd")
            .args(["--port", &port])
            .envs(&child_env)
            .spawn()?,
    );

    wait_for_server(&mut server, DEV_BACKEND_PORT, Duration::from_secs(30))?;
    println!("[xtask] zzz_server listening");

    println!("[xtask] starting vite dev server...");
    let mut vite = ChildGuard::new(
        "vite",
        Command::new(&vite_bin)
            .arg("dev")
            .envs(&child_env)
            .spawn()?,
    );

    // Reap whichever exits first; the guards stop the other on return.
    loop {
        if let Some(status) = server.child.try_wait()? {
            println!("[xtask] zzz_server exited ({status}); stopping vite");
            break;
        }
        if let Some(status) = vite.child.try_wait()? {
            println!("[xtask] vite exited ({status}); stopping zzz_server");
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// The file's assignments to merge: blank (empty or whitespace) values read
/// as unset, as in the `zzz` CLI and `zzzd`, so a template's `KEY=` line
/// neither overrides an exported value nor counts as overriding it.
fn file_values(vars: Vec<(String, String)>) -> BTreeMap<String, String> {
    vars.into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect()
}

/// The keys `file_env` sets that the process env already sets to a
/// different, non-empty value — the ones the file overrides.
fn overridden_keys(
    file_env: &BTreeMap<String, String>,
    process_get: impl Fn(&str) -> Option<OsString>,
) -> Vec<&str> {
    file_env
        .iter()
        .filter(|(key, value)| {
            process_get(key).is_some_and(|current| !current.is_empty() && current != value.as_str())
        })
        .map(|(key, _)| key.as_str())
        .collect()
}

/// A child process that is stopped when the guard drops: `SIGTERM`, a grace
/// period, then `SIGKILL`, and always reaped.
struct ChildGuard {
    name: &'static str,
    child: Child,
}

impl ChildGuard {
    /// Grace period between `SIGTERM` and `SIGKILL`.
    const GRACE: Duration = Duration::from_secs(10);

    const fn new(name: &'static str, child: Child) -> Self {
        Self { name, child }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(None)) {
            return; // already exited (and now reaped), or unknowable
        }
        // `kill(1)` rather than a signal crate: xtask stays std-only. The
        // child is unreaped, so its pid can't have been reused.
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let deadline = Instant::now() + Self::GRACE;
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("[xtask] {} ignored SIGTERM; killing it", self.name);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Wait for the server to accept connections on `port`, failing at once if
/// it exits first (a bad env, an unreachable database).
fn wait_for_server(server: &mut ChildGuard, port: u16, timeout: Duration) -> Result<()> {
    let addr = (Ipv4Addr::LOCALHOST, port);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(status) = server.child.try_wait()? {
            return Err(format!("zzz_server exited before listening ({status})").into());
        }
        if TcpStream::connect(addr).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("zzz_server never listened on {port}").into())
}

/// Create a 32-byte hex bootstrap token at `path` (mode `0600`) if absent.
fn ensure_bootstrap_token(path: &str) -> Result<()> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if create_private_file(path, &random_hex(32)?)? {
        println!("[xtask] created bootstrap token at {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    #[test]
    fn with_cookie_key_replaces_the_placeholder_line() {
        let template = "# header\nDATABASE_URL=postgres://x\n# key comment\nSECRET_FUZ_COOKIE_KEYS=\nOTHER=1\n";
        assert_eq!(
            with_cookie_key(template, "abc"),
            "# header\nDATABASE_URL=postgres://x\n# key comment\nSECRET_FUZ_COOKIE_KEYS=abc\nOTHER=1\n"
        );
        // `export` form and duplicate lines collapse to one assignment
        assert_eq!(
            with_cookie_key(
                "export SECRET_FUZ_COOKIE_KEYS=old\nSECRET_FUZ_COOKIE_KEYS=older\n",
                "k"
            ),
            "SECRET_FUZ_COOKIE_KEYS=k\n"
        );
        // a commented-out line is left alone and the key appended
        assert_eq!(
            with_cookie_key("# SECRET_FUZ_COOKIE_KEYS=x\n", "k"),
            "# SECRET_FUZ_COOKIE_KEYS=x\nSECRET_FUZ_COOKIE_KEYS=k\n"
        );
    }

    #[test]
    fn templates_get_a_generated_key() {
        for template in [".env.development.example", ".env.production.example"] {
            let content = fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join(template),
            )
            .unwrap();
            let before = env_file::parse_env(&content).vars;
            let key_before = before.iter().find(|(k, _)| k == COOKIE_KEYS_VAR);
            // the template itself ships no usable key
            assert_eq!(key_before.map(|(_, v)| v.as_str()), Some(""), "{template}");
            let key = random_hex(32).unwrap();
            let after = env_file::parse_env(&with_cookie_key(&content, &key)).vars;
            assert!(
                after.contains(&(COOKIE_KEYS_VAR.to_owned(), key)),
                "{template}"
            );
            assert_eq!(after.len(), before.len(), "{template}: no lines lost");
        }
    }

    #[test]
    fn blank_file_values_neither_override_nor_report() {
        let file = file_values(
            env_file::parse_env(
                "SECRET_ANTHROPIC_API_KEY=\nSECRET_OPENAI_API_KEY= \nDATABASE_URL=postgres://dev\n",
            )
            .vars,
        );
        assert_eq!(
            file.keys().map(String::as_str).collect::<Vec<_>>(),
            ["DATABASE_URL"]
        );
        let process =
            |key: &str| (key == "SECRET_ANTHROPIC_API_KEY").then(|| OsString::from("sk-exported"));
        assert!(overridden_keys(&file, process).is_empty());
    }

    #[test]
    fn the_file_overrides_differing_process_values() {
        let file = BTreeMap::from([
            (
                "DATABASE_URL".to_owned(),
                "postgres://localhost/zzz".to_owned(),
            ),
            ("SAME".to_owned(), "x".to_owned()),
            ("EMPTY_IN_ENV".to_owned(), "y".to_owned()),
            ("ONLY_FILE".to_owned(), "z".to_owned()),
        ]);
        let process = |key: &str| match key {
            "DATABASE_URL" => Some(OsString::from("postgres://elsewhere/stale")),
            "SAME" => Some(OsString::from("x")),
            "EMPTY_IN_ENV" => Some(OsString::new()),
            _ => None,
        };
        assert_eq!(overridden_keys(&file, process), ["DATABASE_URL"]);
    }

    #[test]
    fn child_guard_terminates_a_running_child_on_drop() {
        let guard = ChildGuard::new("sleep", Command::new("sleep").arg("100").spawn().unwrap());
        let pid = guard.child.id();
        let started = Instant::now();
        drop(guard);
        assert!(started.elapsed() < ChildGuard::GRACE, "stopped by SIGTERM");
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "and reaped");
    }

    #[test]
    fn wait_for_server_reports_an_early_exit() {
        let mut server = ChildGuard::new("false", Command::new("false").spawn().unwrap());
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = wait_for_server(&mut server, port, Duration::from_secs(10)).unwrap_err();
        assert!(err.to_string().contains("exited before listening"), "{err}");
    }

    #[test]
    fn random_hex_is_hex_of_the_requested_length() {
        let hex = random_hex(32).unwrap();
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hex, random_hex(32).unwrap());
    }
}
