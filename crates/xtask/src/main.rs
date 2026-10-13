//! `cargo xtask` — dev and build automation for the zzz workspace.
//!
//! Subcommands:
//! - `dev`        — build `zzz_server`, then run it alongside the Vite frontend
//!   (the dev backend binds `4461`; Vite serves `5460` and proxies `/api` to it).
//! - `dev-setup`  — generate `.env.development` from `.env.development.example`.
//! - `prod-setup` — generate `.env.production` from `.env.production.example`.
//!   Both fill `SECRET_FUZ_COOKIE_KEYS` with a freshly generated key.
//! - `check-release` — the dep-graph audit (sanity check #2 of the test-binary
//!   pattern); its work is delegated to [`fuz_audit::run_check_release_cli`].
//! - no args / `help` / `-h` / `--help` — print the full subcommand list.
//! - any other subcommand, or any argument after one — error to stderr +
//!   usage, non-zero exit.
//!
//! Every subcommand runs from the workspace root (see [`workspace_root`]), so
//! `cargo xtask` works the same from any directory in the checkout: the env
//! files, `node_modules/.bin/vite`, `target/debug/zzzd`, and the relative
//! paths inside `.env.development` (which the children resolve against their
//! working directory) all mean the workspace's.
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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Dev backend port. Vite proxies `/api` here; see `vite.config.ts`.
const DEV_BACKEND_PORT: u16 = 4461;
/// The port `vite.config.ts` pins the dev server to (`strictPort`), so the dev
/// UI's origin is `http://localhost:5460` — the one origin
/// `.env.development.example` allows. It is zzz's own rather than Vite's
/// default: `zzzd` trusts whatever page is served at an allowed origin, and a
/// default port is the one another project's dev server takes when this one
/// isn't running. The copies can't import one another, so the
/// `dev_origin_copies` tests hold them together.
const DEV_FRONTEND_PORT: u16 = 5460;
/// The env var holding `zzzd`'s origin allowlist.
const ALLOWED_ORIGINS_VAR: &str = "FUZ_ALLOWED_ORIGINS";
/// The env var the dev UI builds its server URL from (`src/lib/constants.ts`):
/// the port of the Vite server it was loaded from.
const SERVER_PORT_VAR: &str = "PUBLIC_ZZZ_SERVER_PORT";
const DEV_ENV_FILE: &str = ".env.development";
/// The Vite CLI, run directly so signals reach it (see [`run_dev`]).
const VITE_BIN: &str = "node_modules/.bin/vite";

fn main() -> ExitCode {
    // `args_os`, so a non-UTF-8 argument is an unknown subcommand, not a panic
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let subcommand = match parse_args(&args) {
        Ok(Subcommand::Help) => {
            print_usage();
            return ExitCode::SUCCESS;
        }
        Ok(subcommand) => subcommand,
        Err(message) => {
            eprintln!("[xtask] error: {message}\n");
            print_usage();
            return ExitCode::FAILURE;
        }
    };
    let root = workspace_root();
    if let Err(e) = std::env::set_current_dir(&root) {
        eprintln!(
            "[xtask] error: can't enter the workspace root {}: {e}",
            root.display()
        );
        return ExitCode::FAILURE;
    }
    match subcommand {
        Subcommand::Dev => finish(run_dev()),
        Subcommand::DevSetup => finish(setup_env(DEV_ENV_FILE, ".env.development.example")),
        Subcommand::ProdSetup => finish(setup_env(".env.production", ".env.production.example")),
        // The dep-graph audit is fuz_audit's; everything else (dispatch, help) is ours.
        Subcommand::CheckRelease => fuz_audit::run_check_release_cli(),
        Subcommand::Help => ExitCode::SUCCESS,
    }
}

/// An `xtask` subcommand.
#[derive(Debug, PartialEq, Eq)]
enum Subcommand {
    Dev,
    DevSetup,
    ProdSetup,
    CheckRelease,
    Help,
}

/// Parse the arguments after the program name: one subcommand, nothing
/// after it (none takes arguments — a stray one is refused rather than
/// silently ignored). No arguments is [`Subcommand::Help`].
fn parse_args(args: &[String]) -> std::result::Result<Subcommand, String> {
    let Some((name, rest)) = args.split_first() else {
        return Ok(Subcommand::Help);
    };
    let subcommand = match name.as_str() {
        "dev" => Subcommand::Dev,
        "dev-setup" => Subcommand::DevSetup,
        "prod-setup" => Subcommand::ProdSetup,
        "check-release" => Subcommand::CheckRelease,
        "help" | "-h" | "--help" => Subcommand::Help,
        other => return Err(format!("unknown subcommand `{other}`")),
    };
    if let Some(extra) = rest.first() {
        return Err(format!(
            "`{name}` takes no arguments, got `{extra}`{}",
            if rest.len() > 1 { " …" } else { "" }
        ));
    }
    Ok(subcommand)
}

/// The workspace root: two levels above this crate's manifest directory
/// (`crates/xtask`). See [`workspace_root_from`].
fn workspace_root() -> PathBuf {
    workspace_root_from(std::env::var_os("CARGO_MANIFEST_DIR"))
}

/// The workspace root from `runtime_manifest_dir` — the `CARGO_MANIFEST_DIR`
/// that `cargo run` (so `cargo xtask`) sets for the process — falling back to
/// the one baked in at build time when it's unset (the binary run directly).
/// The runtime value wins because the baked one goes stale: in a copied
/// checkout whose `target/` came along, it still names the original, and
/// xtask would build and write files there.
fn workspace_root_from(runtime_manifest_dir: Option<OsString>) -> PathBuf {
    let manifest_dir = runtime_manifest_dir
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from);
    manifest_dir
        .ancestors()
        .nth(2)
        .map_or_else(|| manifest_dir.clone(), Path::to_path_buf)
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

    // The file is the developer's, so its stale lines are reported, never
    // rewritten: the frontend port a Vite started without xtask would read,
    // and an allowlist that doesn't fit the dev server. For the allowlist the
    // file's value wins; a blank one leaves the inherited value in place.
    let inherited_origins = std::env::var(ALLOWED_ORIGINS_VAR).ok();
    let (allowed_origins, origins_source) = effective_value(
        env.get(ALLOWED_ORIGINS_VAR).map(String::as_str),
        inherited_origins.as_deref(),
    );
    let warnings: Vec<String> = [
        dev_server_port_warning(env.get(SERVER_PORT_VAR).map(String::as_str)),
        dev_origin_warning(allowed_origins, origins_source),
    ]
    .into_iter()
    .flatten()
    .collect();
    for warning in &warnings {
        eprintln!("{warning}");
    }

    // Point the frontend at the dev ports regardless of the env's values (so
    // a stale `.env.development` still works in dev).
    for (key, value) in dev_port_env() {
        env.insert(key.to_owned(), value);
    }
    let port = DEV_BACKEND_PORT.to_string();

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
        Command::new("target/debug/zzzd")
            .args(["--port", &port])
            .envs(&child_env)
            .spawn()?,
    );

    wait_for_server(&mut server, DEV_BACKEND_PORT, Duration::from_secs(30))?;
    println!("[xtask] zzz_server listening");

    // again, beside the address Vite is about to print
    for warning in &warnings {
        eprintln!("{warning}");
    }
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

/// The frontend's port variables as `dev` forces them, whatever
/// `.env.development` says: the UI calls the Vite server it was loaded from —
/// never whatever else holds a port the file names, which would be sent the
/// session cookie — Vite proxies to the backend, and the WebSocket connects
/// to the backend directly.
fn dev_port_env() -> [(&'static str, String); 3] {
    [
        (SERVER_PORT_VAR, DEV_FRONTEND_PORT.to_string()),
        (
            "PUBLIC_ZZZ_SERVER_PROXIED_PORT",
            DEV_BACKEND_PORT.to_string(),
        ),
        (
            "PUBLIC_ZZZ_WEBSOCKET_URL",
            format!("ws://localhost:{DEV_BACKEND_PORT}/api/ws"),
        ),
    ]
}

/// The dev UI's origin: the Vite dev server, as the browser names it.
fn dev_frontend_origin() -> String {
    format!("http://localhost:{DEV_FRONTEND_PORT}")
}

/// Where a variable's value came from, for a message that says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnvSource {
    /// A line of `.env.development`.
    File,
    /// The environment `cargo xtask dev` was started in.
    Inherited,
}

impl EnvSource {
    /// The parenthetical after the variable's name.
    const fn describe(self) -> &'static str {
        match self {
            Self::File => "in .env.development",
            Self::Inherited => {
                "inherited from the environment, as .env.development leaves it unset"
            }
        }
    }
}

/// The value the children get for a variable, and where it came from: the
/// file's (blank ones are already dropped — see [`file_values`]), else the
/// inherited one.
fn effective_value<'a>(
    file: Option<&'a str>,
    inherited: Option<&'a str>,
) -> (Option<&'a str>, EnvSource) {
    file.map_or((inherited, EnvSource::Inherited), |value| {
        (Some(value), EnvSource::File)
    })
}

/// The warning for a `.env.development` whose frontend port line names
/// another port than the dev server's, or `None` when it is unset or right.
///
/// `dev` forces the variable for the Vite it starts, so this run is
/// unaffected — but the file is created once and never rewritten, and a Vite
/// started without xtask reads the line: `vite.config.ts` then refuses to
/// start rather than serve a UI that calls another port.
fn dev_server_port_warning(file_value: Option<&str>) -> Option<String> {
    let value = file_value.filter(|value| !value.trim().is_empty())?;
    let expected = DEV_FRONTEND_PORT.to_string();
    if value == expected {
        return None;
    }
    Some(format!(
        "[xtask] warning: {SERVER_PORT_VAR} in {DEV_ENV_FILE} is `{value}`, but the dev server \
         serves on port {expected}.\n\
         [xtask]   `cargo xtask dev` sets it for this run; a Vite started without xtask \
         (`vite dev`, `gro dev`) reads the file and refuses to start.\n\
         [xtask]   Set this line in {DEV_ENV_FILE}:\n\
         [xtask]     {SERVER_PORT_VAR}={expected}"
    ))
}

/// The warnings for an origin allowlist that doesn't fit the dev server, or
/// `None` when it does. Two independent ones:
///
/// - **No entry admits the dev UI's origin.** `zzzd` refuses a browser request
///   from an origin its allowlist doesn't admit (403 `forbidden_origin`), which
///   from the UI looks like a backend that never answers. Decided by `zzzd`'s
///   matching rule ([`origin_matches_pattern`]), so a wildcard entry counts
///   only when it covers the origin.
/// - **An entry is a loopback origin on a default Vite port.** `zzzd` trusts
///   whatever page is served at a listed origin, and that port is the one
///   another project's dev server holds — the entry a list written for a
///   default-port dev server leaves behind.
///
/// `.env.development` is created once and never rewritten, so its list can be
/// either. An unset or blank list is left to `zzzd`, which refuses to boot on
/// one.
fn dev_origin_warning(allowed_origins: Option<&str>, source: EnvSource) -> Option<String> {
    let allowed_origins = allowed_origins.filter(|value| !value.trim().is_empty())?;
    let origin = dev_frontend_origin();
    let entries: Vec<&str> = allowed_origins
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    let where_from = source.describe();
    let mut warnings = Vec::new();

    if !entries
        .iter()
        .any(|entry| origin_matches_pattern(&origin, entry))
    {
        warnings.push(format!(
            "[xtask] warning: {ALLOWED_ORIGINS_VAR} ({where_from}) is `{allowed_origins}`, which \
             doesn't admit the dev UI's origin, {origin}.\n\
             [xtask]   zzzd will refuse the UI's login, RPC calls, and WebSocket (403 \
             forbidden_origin).\n\
             [xtask]   Set this line in {DEV_ENV_FILE}, then restart:\n\
             [xtask]     {ALLOWED_ORIGINS_VAR}={origin}"
        ));
    }

    let leftovers: Vec<String> = entries
        .iter()
        .filter(|entry| is_default_vite_loopback_origin(entry))
        .map(|entry| format!("`{entry}`"))
        .collect();
    if !leftovers.is_empty() {
        let fix = match source {
            EnvSource::File => format!("Remove it from that line in {DEV_ENV_FILE}, then restart."),
            EnvSource::Inherited => format!(
                "Remove it from the exported value, or set the line in {DEV_ENV_FILE} (the \
                 file wins), then restart."
            ),
        };
        warnings.push(format!(
            "[xtask] warning: {ALLOWED_ORIGINS_VAR} ({where_from}) lists {}, a default Vite \
             port on loopback.\n\
             [xtask]   zzzd trusts whatever page is served there, and another project's dev \
             server takes that port — its page could act with your zzz session.\n\
             [xtask]   {fix}",
            leftovers.join(", ")
        ));
    }

    if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("\n"))
    }
}

/// Whether `port` is one a Vite left on its defaults takes: from 5173 up for
/// `vite dev` and from 4173 up for `vite preview`, the first free port from
/// there, so the near ones too.
fn is_default_vite_port(port: u16) -> bool {
    (5173..5273).contains(&port) || (4173..4273).contains(&port)
}

/// Whether an allowlist entry is exactly a plain-http loopback origin
/// (`localhost`, `127.0.0.1`, `[::1]`) on a default Vite port.
fn is_default_vite_loopback_origin(entry: &str) -> bool {
    let Some((scheme, authority)) = entry.split_once("://") else {
        return false;
    };
    let (host, port) = split_host_port(authority);
    scheme.eq_ignore_ascii_case("http")
        && ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|loopback| host.eq_ignore_ascii_case(loopback))
        && port
            .and_then(|port| port.parse().ok())
            .is_some_and(is_default_vite_port)
}

/// Whether the allowlist entry `pattern` admits `origin`, by the rule `zzzd`
/// applies to a request's `Origin` (`fuz_http::check_origin`, which xtask
/// doesn't link — the tests hold this copy to the same answers).
///
/// Entries are `scheme://host[:port]`, http or https, compared
/// case-insensitively. A `*` host label matches exactly one label, and a `:*`
/// port matches any port or none. A malformed entry admits nothing.
fn origin_matches_pattern(origin: &str, pattern: &str) -> bool {
    if pattern.eq_ignore_ascii_case(origin) {
        return true;
    }
    let (Some((p_scheme, p_authority)), Some((o_scheme, o_authority))) =
        (pattern.split_once("://"), origin.split_once("://"))
    else {
        return false;
    };
    if !(p_scheme.eq_ignore_ascii_case("http") || p_scheme.eq_ignore_ascii_case("https")) {
        return false;
    }
    if !p_scheme.eq_ignore_ascii_case(o_scheme) {
        return false;
    }
    let (p_host, p_port) = split_host_port(p_authority);
    let (o_host, o_port) = split_host_port(o_authority);
    let port_ok = match p_port {
        Some("*") => o_port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        Some(explicit) => o_port == Some(explicit),
        None => o_port.is_none(),
    };
    port_ok && host_matches(p_host, o_host)
}

/// An authority as `(host, port)`; a bracketed IPv6 literal keeps its
/// brackets.
fn split_host_port(authority: &str) -> (&str, Option<&str>) {
    if authority.starts_with('[') {
        return authority.find(']').map_or((authority, None), |end| {
            (&authority[..=end], authority[end + 1..].strip_prefix(':'))
        });
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    }
}

/// A host against a host pattern, label by label: `*` is exactly one
/// non-empty label, and a bracketed IPv6 literal compares whole.
fn host_matches(pattern_host: &str, origin_host: &str) -> bool {
    if pattern_host.starts_with('[') || origin_host.starts_with('[') {
        return pattern_host.eq_ignore_ascii_case(origin_host);
    }
    if pattern_host.split('.').count() != origin_host.split('.').count() {
        return false;
    }
    pattern_host
        .split('.')
        .zip(origin_host.split('.'))
        .all(|(pattern_label, origin_label)| {
            if pattern_label == "*" {
                !origin_label.is_empty()
            } else {
                !pattern_label.contains('*') && pattern_label.eq_ignore_ascii_case(origin_label)
            }
        })
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

    fn args(args: &[&str]) -> Vec<String> {
        args.iter().map(|&arg| arg.to_owned()).collect()
    }

    #[test]
    fn parse_args_takes_one_subcommand_and_nothing_after_it() {
        assert_eq!(parse_args(&[]), Ok(Subcommand::Help));
        for (arg, expected) in [
            ("dev", Subcommand::Dev),
            ("dev-setup", Subcommand::DevSetup),
            ("prod-setup", Subcommand::ProdSetup),
            ("check-release", Subcommand::CheckRelease),
            ("help", Subcommand::Help),
            ("-h", Subcommand::Help),
            ("--help", Subcommand::Help),
        ] {
            assert_eq!(parse_args(&args(&[arg])), Ok(expected), "{arg}");
        }
        assert_eq!(
            parse_args(&args(&["dev", "--port", "5000"])),
            Err("`dev` takes no arguments, got `--port` …".to_owned())
        );
        assert_eq!(
            parse_args(&args(&["check-release", "x"])),
            Err("`check-release` takes no arguments, got `x`".to_owned())
        );
        assert_eq!(
            parse_args(&args(&["deploy", "x"])),
            Err("unknown subcommand `deploy`".to_owned())
        );
    }

    #[test]
    fn workspace_root_prefers_the_runtime_manifest_dir() {
        assert_eq!(
            workspace_root_from(Some(OsString::from("/copy/zzz/crates/xtask"))),
            Path::new("/copy/zzz")
        );
        let built = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap();
        assert_eq!(
            workspace_root_from(None),
            built,
            "falls back to the build's"
        );
        assert_eq!(
            workspace_root_from(Some(OsString::new())),
            built,
            "blank is unset"
        );
    }

    #[test]
    fn workspace_root_is_the_cargo_workspace() {
        let root = workspace_root();
        let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
        assert!(manifest.contains("[workspace]"), "{}", root.display());
        assert!(root.join("package.json").is_file(), "{}", root.display());
        assert!(root.join(".env.development.example").is_file());
    }

    #[test]
    fn templates_get_a_generated_key() {
        for template in [".env.development.example", ".env.production.example"] {
            let content = fs::read_to_string(workspace_root().join(template)).unwrap();
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
    fn a_list_that_does_not_admit_the_dev_origin_is_reported_with_the_line_to_set() {
        for stale in [
            // Vite's default ports, by either name
            "http://localhost:5173,http://127.0.0.1:5173",
            "http://localhost:5173",
            // the dev port under a name the dev server may not be bound to
            "http://127.0.0.1:5460",
            "http://[::1]:5460",
            "https://localhost:5460",
            "http://localhost:54600",
            // the backend's own port serves no page in dev
            "http://localhost:4461",
            // wildcards that don't cover the dev origin
            "https://*.example.com",
            "https://localhost:*",
            "http://*.localhost:*",
            "http://*",
            "http://127.0.0.1:*",
            "http://*.*:5460",
            // malformed entries admit nothing
            "http://localhost:5460/",
            "localhost:5460",
            "http://local*:5460",
            "*",
        ] {
            for source in [EnvSource::File, EnvSource::Inherited] {
                let warning = dev_origin_warning(Some(stale), source).expect(stale);
                assert!(warning.contains(&format!("is `{stale}`")), "{warning}");
                assert!(
                    warning.contains("doesn't admit the dev UI's origin, http://localhost:5460"),
                    "{warning}"
                );
                assert!(
                    warning.contains(
                        "Set this line in .env.development, then restart:\n\
                         [xtask]     FUZ_ALLOWED_ORIGINS=http://localhost:5460"
                    ),
                    "{warning}"
                );
                assert!(warning.contains("403 forbidden_origin"), "{warning}");
                // what is refused: not the same-origin GETs, which carry no `Origin`
                assert!(
                    warning.contains("the UI's login, RPC calls, and WebSocket"),
                    "{warning}"
                );
                assert!(!warning.contains("every request"), "{warning}");
            }
        }
    }

    #[test]
    fn a_list_that_admits_the_dev_origin_is_quiet() {
        for fine in [
            "http://localhost:5460",
            "HTTP://LocalHost:5460",
            " http://localhost:5460 ",
            "https://zzz.example.com, http://localhost:5460",
            "http://localhost:5460,,",
            // wildcards that cover the dev origin
            "http://localhost:*",
            "http://*:5460",
            "http://*:*",
            "https://*.example.com,http://*:*",
            // other ports that are not a default Vite's
            "http://localhost:5460,http://localhost:5461,http://127.0.0.1:4460",
        ] {
            for source in [EnvSource::File, EnvSource::Inherited] {
                assert_eq!(dev_origin_warning(Some(fine), source), None, "{fine}");
            }
        }
        // unset or blank: zzzd refuses to boot, with its own message
        for unset in [None, Some(""), Some("  ")] {
            assert_eq!(
                dev_origin_warning(unset, EnvSource::File),
                None,
                "{unset:?}"
            );
        }
    }

    #[test]
    fn a_leftover_default_vite_origin_is_reported_beside_the_dev_origin() {
        for (list, leftovers) in [
            (
                "http://localhost:5460,http://localhost:5173",
                "`http://localhost:5173`",
            ),
            (
                "http://localhost:5173, http://127.0.0.1:5173 ,http://localhost:5460",
                "`http://localhost:5173`, `http://127.0.0.1:5173`",
            ),
            (
                "http://localhost:5460,HTTP://LocalHost:5174",
                "`HTTP://LocalHost:5174`",
            ),
            (
                "http://localhost:5460,http://127.0.0.1:5180",
                "`http://127.0.0.1:5180`",
            ),
            (
                "http://localhost:5460,http://[::1]:5173",
                "`http://[::1]:5173`",
            ),
            (
                "http://localhost:5460,http://localhost:4173",
                "`http://localhost:4173`",
            ),
            // the wildcard admits the dev UI; the exact entry is still a leftover
            (
                "http://*:5460,http://127.0.0.1:4173",
                "`http://127.0.0.1:4173`",
            ),
        ] {
            let warning = dev_origin_warning(Some(list), EnvSource::File).expect(list);
            assert!(
                warning.starts_with(&format!(
                    "[xtask] warning: FUZ_ALLOWED_ORIGINS (in .env.development) lists \
                     {leftovers}, a default Vite port on loopback.\n"
                )),
                "{warning}"
            );
            assert!(
                warning.ends_with("Remove it from that line in .env.development, then restart."),
                "{warning}"
            );
            // the dev origin is admitted, so only the one warning
            assert!(!warning.contains("doesn't admit"), "{warning}");
            assert_eq!(warning.matches("[xtask] warning:").count(), 1, "{warning}");
        }
    }

    #[test]
    fn a_stale_list_gets_both_warnings() {
        let warning = dev_origin_warning(
            Some("http://localhost:5173,http://127.0.0.1:5173"),
            EnvSource::File,
        )
        .unwrap();
        assert_eq!(warning.matches("[xtask] warning:").count(), 2, "{warning}");
        assert!(warning.contains("doesn't admit"), "{warning}");
        assert!(
            warning.contains("lists `http://localhost:5173`, `http://127.0.0.1:5173`, a default"),
            "{warning}"
        );
    }

    #[test]
    fn only_exact_plain_http_loopback_entries_on_a_default_vite_port_are_leftovers() {
        for entry in [
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:5180",
            "http://localhost:5272",
            "http://localhost:4173",
            "http://localhost:4272",
            "http://127.0.0.1:5173",
            "http://[::1]:4173",
            "HTTP://LOCALHOST:5173",
        ] {
            assert!(is_default_vite_loopback_origin(entry), "{entry}");
        }
        for entry in [
            "http://localhost:5460",
            "http://localhost:5461",
            "http://localhost:4460",
            "http://localhost:4461",
            "http://localhost:5172",
            "http://localhost:5273",
            "http://localhost:4172",
            "http://localhost:4273",
            "http://localhost",
            "http://localhost:*",
            "https://localhost:5173",
            "http://example.com:5173",
            "http://evil.localhost:5173",
            "http://192.168.1.10:5173",
            "http://[::2]:5173",
            "http://*:5173",
            "localhost:5173",
        ] {
            assert!(!is_default_vite_loopback_origin(entry), "{entry}");
            assert_eq!(
                dev_origin_warning(
                    Some(&format!("http://localhost:5460,{entry}")),
                    EnvSource::File
                ),
                None,
                "{entry}"
            );
        }
    }

    #[test]
    fn an_origin_warning_says_where_the_value_came_from() {
        for list in [
            "http://localhost:5173",
            "http://localhost:5460,http://localhost:5173",
        ] {
            let from_file = dev_origin_warning(Some(list), EnvSource::File).unwrap();
            assert!(
                from_file.contains("FUZ_ALLOWED_ORIGINS (in .env.development) "),
                "{from_file}"
            );
            assert!(!from_file.contains("inherited"), "{from_file}");
            assert!(!from_file.contains("exported value"), "{from_file}");

            let inherited = dev_origin_warning(Some(list), EnvSource::Inherited).unwrap();
            assert!(
                inherited.contains(
                    "FUZ_ALLOWED_ORIGINS (inherited from the environment, as .env.development \
                     leaves it unset) "
                ),
                "{inherited}"
            );
            assert!(!inherited.contains("(in .env.development)"), "{inherited}");
            assert!(
                inherited.contains("Remove it from the exported value, or set the line in"),
                "{inherited}"
            );
            assert!(!inherited.contains("from that line"), "{inherited}");
        }
    }

    /// `zzzd`'s own answers (`fuz_http::check_origin` on a one-entry list),
    /// as `(entry, origin, admitted)`.
    #[test]
    fn origin_matching_agrees_with_zzzd() {
        for (pattern, origin, admitted) in [
            ("http://localhost:5460", "http://localhost:5460", true),
            ("http://localhost:5460", "http://localhost:5173", false),
            ("http://localhost:5460", "http://127.0.0.1:5460", false),
            ("HTTP://LocalHost:5460", "http://localhost:5460", true),
            ("https://zzz.example.com", "https://zzz.example.com", true),
            (
                "https://zzz.example.com",
                "https://zzz.example.com:443",
                false,
            ),
            ("https://zzz.example.com", "http://zzz.example.com", false),
            (
                "https://zzz.example.com:443",
                "https://zzz.example.com",
                false,
            ),
            ("http://localhost:80", "http://localhost", false),
            ("http://[::1]:5460", "http://[::1]:5460", true),
            (
                "http://[2001:DB8::1]:5460",
                "http://[2001:db8::1]:5460",
                true,
            ),
            ("http://[0:0:0:0:0:0:0:1]:5460", "http://[::1]:5460", false),
            ("http://localhost.", "http://localhost", false),
            ("ws://localhost:5460", "ws://localhost:5460", true),
            ("file://", "null", false),
            ("*", "*", true),
            ("*", "http://localhost:5460", false),
            ("http://localhost:*", "http://localhost", true),
            ("http://localhost:*", "http://localhost:1", true),
            ("http://localhost:*", "http://localhost:5173", true),
            ("http://localhost:*", "http://localhost.:1", false),
            ("http://localhost:*", "http://evil.localhost:1", false),
            ("http://localhost:*", "https://localhost:1", false),
            ("http://[::1]:*", "http://[::1]:9", true),
            ("http://[::1]:*", "http://[::2]:9", false),
            ("https://*.example.com", "https://a.example.com", true),
            ("https://*.example.com", "https://a.b.example.com", false),
            ("https://*.example.com", "https://example.com", false),
            ("https://*.example.com", "https://a.example.com:8443", false),
            ("https://*.example.com", "http://a.example.com", false),
            (
                "https://*.example.com:*",
                "https://a.example.com:8443",
                true,
            ),
            ("https://*.example.com:*", "https://a.example.com", true),
            ("https://example.*", "https://example.evil", true),
            ("http://192.168.1.*", "http://192.168.1.77", true),
            ("http://*", "http://localhost", true),
            ("http://*", "http://[::1]", false),
            ("http://*", "http://a.b", false),
            ("http://*", "http://localhost:5173", false),
            ("http://*:*", "http://localhost:5173", true),
            ("http://*:*", "http://[::1]:5173", false),
            ("http://*.", "http://localhost.", true),
            ("http://*.", "http://localhost", false),
            ("https://*.*", "https://evil.example", true),
            ("http://*.*.*.*:*", "http://10.0.0.7:9", true),
            (
                "https://*foo.example.com",
                "https://afoo.example.com",
                false,
            ),
            (
                "https://*.*.corp.example.com",
                "https://a.b.corp.example.com",
                true,
            ),
            ("http://localhost:5460/", "http://localhost:5460", false),
            ("localhost:5460", "http://localhost:5460", false),
            ("localhost:5460", "localhost:5460", true),
            ("http://user@localhost:5460", "http://localhost:5460", false),
            ("http://localhost:05460", "http://localhost:5460", false),
            ("http://localhost:", "http://localhost", false),
            ("http://localhost:", "http://localhost:", true),
        ] {
            assert_eq!(
                origin_matches_pattern(origin, pattern),
                admitted,
                "{pattern} <- {origin}"
            );
        }
        // a `:*` port is a number when present
        assert!(!origin_matches_pattern(
            "http://localhost:abc",
            "http://localhost:*"
        ));
        assert!(!origin_matches_pattern(
            "http://localhost:",
            "http://localhost:*"
        ));
        // a `*` label is non-empty, and a non-http(s) entry matches only itself
        assert!(!origin_matches_pattern(
            "https://.example.com",
            "https://*.example.com"
        ));
        assert!(!origin_matches_pattern(
            "ws://a.example.com",
            "ws://*.example.com"
        ));
    }

    #[test]
    fn the_file_value_wins_and_the_source_is_recorded() {
        assert_eq!(
            effective_value(Some("file"), Some("inherited")),
            (Some("file"), EnvSource::File)
        );
        assert_eq!(
            effective_value(Some("file"), None),
            (Some("file"), EnvSource::File)
        );
        assert_eq!(
            effective_value(None, Some("inherited")),
            (Some("inherited"), EnvSource::Inherited)
        );
        assert_eq!(effective_value(None, None), (None, EnvSource::Inherited));
    }

    #[test]
    fn a_stale_frontend_port_line_is_reported_with_the_line_to_set() {
        for stale in ["5173", "4461", "54600", "05460", " 5460"] {
            let warning = dev_server_port_warning(Some(stale)).expect(stale);
            assert!(
                warning.starts_with(&format!(
                    "[xtask] warning: PUBLIC_ZZZ_SERVER_PORT in .env.development is `{stale}`, \
                     but the dev server serves on port 5460.\n"
                )),
                "{warning}"
            );
            assert!(
                warning.ends_with(
                    "Set this line in .env.development:\n\
                     [xtask]     PUBLIC_ZZZ_SERVER_PORT=5460"
                ),
                "{warning}"
            );
        }
        for fine in [Some("5460"), None, Some(""), Some("  ")] {
            assert_eq!(dev_server_port_warning(fine), None, "{fine:?}");
        }
    }

    #[test]
    fn dev_forces_the_frontend_onto_the_dev_ports() {
        assert_eq!(
            dev_port_env(),
            [
                ("PUBLIC_ZZZ_SERVER_PORT", "5460".to_owned()),
                ("PUBLIC_ZZZ_SERVER_PROXIED_PORT", "4461".to_owned()),
                (
                    "PUBLIC_ZZZ_WEBSOCKET_URL",
                    "ws://localhost:4461/api/ws".to_owned()
                ),
            ]
        );
        assert_eq!(dev_port_env()[0].0, SERVER_PORT_VAR);
        assert_eq!(dev_server_port_warning(Some(&dev_port_env()[0].1)), None);
    }

    /// The dev UI's origin is written down in places that can't import one
    /// another: [`DEV_FRONTEND_PORT`], the port Vite is pinned to, the env
    /// template `dev-setup` copies, and the setup docs.
    mod dev_origin_copies {
        use super::*;

        fn read(path: &str) -> String {
            fs::read_to_string(workspace_root().join(path)).unwrap()
        }

        /// The `port` of the `block: { ... }` object in the Vite config, and
        /// that object's own fields from its first `port:` on.
        fn vite_block_port(config: &str, block: &str) -> (u16, String) {
            let opening = format!("\n\t{block}: {{");
            let (_, body) = config
                .split_once(&opening)
                .unwrap_or_else(|| panic!("vite.config.ts has a `{block}` block"));
            // the block's own fields come before the next top-level key
            let body = body.split("\n\t}").next().unwrap();
            assert!(
                !body.contains("\n\t\thost:"),
                "`{block}` sets no host: binding one address family leaves \
                 `localhost` on the other free for another process"
            );
            let (_, rest) = body
                .split_once("\n\t\tport: ")
                .unwrap_or_else(|| panic!("`{block}` pins a port"));
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let port = digits
                .parse()
                .unwrap_or_else(|_| panic!("`{block}.port` is a number"));
            (port, rest.to_owned())
        }

        /// The value a template assigns `key`.
        fn template_value(template: &str, key: &str) -> String {
            let vars = env_file::parse_env(&read(template)).vars;
            let mut values = vars.into_iter().filter(|(k, _)| k == key);
            let (_, value) = values
                .next()
                .unwrap_or_else(|| panic!("{template} sets {key}"));
            assert!(values.next().is_none(), "{template} sets {key} once");
            value
        }

        #[test]
        fn vite_serves_the_dev_origin_and_cannot_move() {
            let (port, rest) = vite_block_port(&read("vite.config.ts"), "server");
            assert_eq!(port, DEV_FRONTEND_PORT);
            assert!(rest.contains("strictPort: true"), "`server` is strictPort");
        }

        /// `vite.config.ts` refuses to start a dev server whose port differs
        /// from the loaded `PUBLIC_ZZZ_SERVER_PORT`, so the value `dev` forces
        /// must be the port it serves on — and the variable's name is written
        /// on both sides.
        #[test]
        fn the_forced_frontend_port_passes_the_vite_port_check() {
            let config = read("vite.config.ts");
            let (port, _) = vite_block_port(&config, "server");
            let forced = dev_port_env();
            let (key, value) = &forced[0];
            assert_eq!(*value, port.to_string());
            assert!(
                read("src/lib/dev_server_port.ts")
                    .contains(&format!("export const DEV_SERVER_PORT_VAR = '{key}';")),
                "the check reads {key}"
            );
            assert!(
                config.contains("\n\t\tzzz_dev_server_port(),\n")
                    && config.contains("check_dev_server_port({")
                    && config.contains("if (error) throw new Error(error);"),
                "vite.config.ts runs the port check"
            );
        }

        #[test]
        fn vite_preview_is_pinned_to_a_port_the_template_does_not_allow() {
            let (port, rest) = vite_block_port(&read("vite.config.ts"), "preview");
            assert!(rest.contains("strictPort: true"), "`preview` is strictPort");
            assert_ne!(port, DEV_FRONTEND_PORT);
            let allowed = template_value(".env.development.example", ALLOWED_ORIGINS_VAR);
            assert!(
                !allowed.contains(&format!(":{port}")),
                "the preview origin is opt-in: {allowed}"
            );
        }

        #[test]
        fn neither_vite_port_is_one_a_default_vite_takes() {
            let config = read("vite.config.ts");
            for block in ["server", "preview"] {
                let (port, _) = vite_block_port(&config, block);
                assert!(
                    !is_default_vite_port(port),
                    "`{block}.port` {port} is in a default Vite's range"
                );
            }
        }

        #[test]
        fn the_dev_template_allows_exactly_the_dev_origin() {
            let allowed = template_value(".env.development.example", ALLOWED_ORIGINS_VAR);
            assert_eq!(allowed, dev_frontend_origin());
            assert_eq!(dev_origin_warning(Some(&allowed), EnvSource::File), None);
            let server_port = template_value(".env.development.example", SERVER_PORT_VAR);
            assert_eq!(
                server_port,
                DEV_FRONTEND_PORT.to_string(),
                "the UI calls the Vite server"
            );
            assert_eq!(dev_server_port_warning(Some(&server_port)), None);
        }

        #[test]
        fn no_template_allows_a_wildcard_origin() {
            for template in [".env.development.example", ".env.production.example"] {
                let allowed = template_value(template, ALLOWED_ORIGINS_VAR);
                assert!(!allowed.is_empty(), "{template}");
                assert!(!allowed.contains('*'), "{template}: {allowed}");
            }
        }

        #[test]
        fn the_setup_docs_name_the_dev_origin() {
            let address = format!("localhost:{DEV_FRONTEND_PORT}");
            for doc in ["README.md", "docs/development.md"] {
                assert!(read(doc).contains(&address), "{doc} says {address}");
            }
        }
    }

    #[test]
    fn random_hex_is_hex_of_the_requested_length() {
        let hex = random_hex(32).unwrap();
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hex, random_hex(32).unwrap());
    }
}
