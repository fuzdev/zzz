//! Building the `zzzd` launch: binary, port, static dir, working directory,
//! and environment.
//!
//! The daemon runs with `~/.zzz` (the daemon home) as its working directory.
//!
//! **Paths.** For the path-valued vars — `PUBLIC_ZZZ_DIR` (default `.zzz`,
//! i.e. `~/.zzz/.zzz`), `PUBLIC_ZZZ_SCOPED_DIRS`, `FUZ_BOOTSTRAP_TOKEN_PATH`,
//! `ZZZ_STATIC_DIR` — the CLI expands a leading `~`; a relative value from
//! `~/.zzz/.env` stays relative to `~/.zzz`, and a relative value from the
//! CLI's own environment is made absolute against the directory `zzz` runs
//! in, where it was written.
//!
//! **Environment.** The child inherits the CLI's environment; `~/.zzz/.env`
//! fills in every variable the environment doesn't set (or sets blank),
//! then CLI defaults fill `FUZ_ALLOWED_ORIGINS`. The environment winning is
//! reported: a note names each `.env` key it overrides with a different
//! value (names only, never values). A blank (empty or
//! whitespace) value is unset: the CLI never passes one for a variable
//! `zzzd` reads or the file names — it removes it from the child's env. Lines of `.env` that aren't
//! assignments are skipped with a warning naming their line numbers. `zzzd` has no dotenv loader of its
//! own, so this is where its config comes from. `DATABASE_URL` and
//! `SECRET_FUZ_COOKIE_KEYS` are required up front, so a missing one is a
//! clear CLI error rather than a daemon that dies at boot.
//! `ZZZ_ENABLE_TEST_ACTIONS` is never passed on (a warning says so when it
//! was set): the test-only actions have no place in a daemon the CLI starts.
//!
//! **Port.** `--port` > `ZZZ_PORT` > `zzz_config_port` in
//! `~/.zzz/config.json` > [`DEFAULT_PORT`](crate::daemon_lifecycle::DEFAULT_PORT),
//! always passed to `zzzd` as `--port`. Every source must be a port in
//! `1..=65535` ([`dl::parse_port`]), and a `config.json` that exists must
//! parse — an invalid value is an error naming its source, never a fallback.
//!
//! **Static dir.** `ZZZ_STATIC_DIR` when set (it must be a directory), else
//! `~/.zzz/static`; passed as `--static-dir`. Neither → an error, since the
//! daemon would serve no UI.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::CliError;
use crate::daemon_lifecycle::{self as dl, DEFAULT_PORT};
use crate::env_file;

/// Env vars `zzzd` refuses to boot without, checked before spawning.
const REQUIRED_ENV: &[&str] = &["DATABASE_URL", "SECRET_FUZ_COOKIE_KEYS"];

/// The env vars `zzzd` reads (besides [`REQUIRED_ENV`], [`PATH_VARS`], and
/// [`TEST_ACTIONS_ENV`]): a blank inherited value for any of them is
/// removed, not passed on.
const ZZZD_ENV: &[&str] = &[
    "ZZZ_PORT",
    "FUZ_ALLOWED_ORIGINS",
    "ZZZ_TRUSTED_PROXIES",
    "SECRET_ANTHROPIC_API_KEY",
    "SECRET_OPENAI_API_KEY",
    "SECRET_GOOGLE_API_KEY",
];

/// Registers `zzzd`'s test-only actions — never passed to a daemon the CLI
/// starts, from either source.
const TEST_ACTIONS_ENV: &str = "ZZZ_ENABLE_TEST_ACTIONS";

/// Path-valued env vars the CLI resolves, with whether each is a
/// comma-separated list.
const PATH_VARS: &[(&str, bool)] = &[
    ("ZZZ_STATIC_DIR", false),
    ("PUBLIC_ZZZ_DIR", false),
    ("FUZ_BOOTSTRAP_TOKEN_PATH", false),
    ("PUBLIC_ZZZ_SCOPED_DIRS", true),
];

/// Everything needed to spawn `zzzd` but the binary, which the caller
/// resolves ([`dl::resolve_server_bin`]) once the port is known to be free.
///
/// Not `Debug`: `env_overlay` holds secrets (the cookie key, API keys).
pub struct DaemonLaunch {
    /// The port passed as `--port`.
    pub port: u16,
    /// The built UI passed as `--static-dir`.
    pub static_dir: PathBuf,
    /// The daemon's working directory, `~/.zzz`.
    pub cwd: PathBuf,
    /// Variables set on top of the inherited environment.
    pub env_overlay: BTreeMap<String, String>,
    /// Inherited variables removed from the child's environment (blank
    /// values, which read as unset, and [`TEST_ACTIONS_ENV`]).
    pub env_remove: Vec<String>,
}

impl DaemonLaunch {
    /// Resolve the launch from `~/.zzz` (which must exist), its `.env`, the
    /// process environment, and `port_flag`.
    pub fn prepare(port_flag: Option<u16>) -> Result<Self, CliError> {
        let cwd = dl::require_zzz_dir()?;
        let env_path = cwd.join(".env");
        let file_env = read_env_file(&env_path)?;
        let file_keys: Vec<String> = file_env.iter().map(|(key, _)| key.clone()).collect();
        let process_get = |key: &str| std::env::var_os(key);
        let cli_cwd = std::env::current_dir().ok();
        let overridden = overridden_file_keys(&file_env, process_get, cli_cwd.as_deref(), &cwd);
        if !overridden.is_empty() {
            eprintln!(
                "note: the environment overrides {} from {}",
                overridden.join(", "),
                env_path.display()
            );
        }
        let mut env_overlay = overlay_file_env(file_env, process_get);
        if strip_test_actions(&mut env_overlay, process_get) {
            eprintln!(
                "warning: ignoring {TEST_ACTIONS_ENV}: a daemon zzz starts never registers the test-only actions"
            );
        }
        resolve_path_vars(&mut env_overlay, process_get, cli_cwd.as_deref())?;
        let mut env_remove = drop_blank_values(&mut env_overlay, &file_keys, process_get);
        if !env_remove.iter().any(|key| key == TEST_ACTIONS_ENV) {
            env_remove.push(TEST_ACTIONS_ENV.to_owned());
        }
        let get = |key: &str| lookup(key, process_get, &env_overlay);

        let config_port = config_port(&cwd)?;
        let port = resolve_port(port_flag, get("ZZZ_PORT").as_deref(), config_port)?;
        let static_dir = resolve_static_dir(get("ZZZ_STATIC_DIR").as_deref(), &cwd)?;

        let missing: Vec<&str> = REQUIRED_ENV
            .iter()
            .copied()
            .filter(|key| get(key).is_none_or(|value| value.trim().is_empty()))
            .collect();
        if !missing.is_empty() {
            return Err(CliError::MissingEnv {
                vars: missing.join(", "),
                env_path: env_path.display().to_string(),
            });
        }

        if get("FUZ_ALLOWED_ORIGINS").is_none_or(|value| value.trim().is_empty()) {
            env_overlay.insert("FUZ_ALLOWED_ORIGINS".to_owned(), default_origins(port));
        }

        Ok(Self {
            port,
            static_dir,
            cwd,
            env_overlay,
            env_remove,
        })
    }

    /// The `zzzd` command running `bin`: `--port`, `--static-dir`, working
    /// directory, and env overlay set; stdio left to the caller.
    #[must_use]
    pub fn command(&self, bin: &Path) -> std::process::Command {
        let mut command = std::process::Command::new(bin);
        command
            .arg("--port")
            .arg(self.port.to_string())
            .arg("--static-dir")
            .arg(&self.static_dir)
            .current_dir(&self.cwd);
        for key in &self.env_remove {
            command.env_remove(key);
        }
        command.envs(&self.env_overlay);
        command
    }
}

/// Read and parse an env file (a missing file is empty), warning about
/// skipped lines by number — never echoing them, as they may hold secrets.
fn read_env_file(path: &Path) -> Result<Vec<(String, String)>, CliError> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let parsed = env_file::parse_env(&content);
            if !parsed.skipped_lines.is_empty() {
                let lines: Vec<String> = parsed
                    .skipped_lines
                    .iter()
                    .map(ToString::to_string)
                    .collect();
                eprintln!(
                    "warning: {}: skipped line(s) {} (not `KEY=value` assignments)",
                    path.display(),
                    lines.join(", ")
                );
            }
            Ok(parsed.vars)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(CliError::Daemon(format!(
            "can't read {}: {e}",
            path.display()
        ))),
    }
}

/// Whether an env value is blank — empty or whitespace — which reads as
/// unset. (A non-UTF-8 value is not blank.)
fn is_blank(value: &OsStr) -> bool {
    value.to_str().is_some_and(|v| v.trim().is_empty())
}

/// The file's values for keys the process environment doesn't set, or sets
/// blank (a later line wins over an earlier one for the same key).
fn overlay_file_env(
    file_env: Vec<(String, String)>,
    process_get: impl Fn(&str) -> Option<OsString>,
) -> BTreeMap<String, String> {
    file_env
        .into_iter()
        .filter(|(key, _)| process_get(key).is_none_or(|value| is_blank(&value)))
        .collect()
}

/// The `.env` keys the process environment overrides: set there to a
/// non-blank value different from the file's (its last line for the key).
/// Sorted; [`TEST_ACTIONS_ENV`] is left out (it's never passed on at all).
///
/// [`PATH_VARS`] compare as the paths the daemon would get, since the two
/// sources resolve differently (see the module doc): `~/app` in the file and
/// an exported `/home/me/app` are the same, while one relative value is two
/// different paths — against `cli_cwd` from the environment, against
/// `zzz_dir` from the file.
fn overridden_file_keys(
    file_env: &[(String, String)],
    process_get: impl Fn(&str) -> Option<OsString>,
    cli_cwd: Option<&Path>,
    zzz_dir: &Path,
) -> Vec<String> {
    let file_values: BTreeMap<&str, &str> = file_env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let effective = |key: &str, value: &str, base: &Path| {
        PATH_VARS
            .iter()
            .find(|&&(path_key, _)| path_key == key)
            .map_or_else(
                || value.to_owned(),
                |&(_, is_list)| {
                    map_paths(value, is_list, |path| {
                        base.join(fuz_sys::expand_tilde(path))
                            .to_string_lossy()
                            .into_owned()
                    })
                },
            )
    };
    file_values
        .into_iter()
        .filter(|&(key, value)| key != TEST_ACTIONS_ENV && !value.trim().is_empty())
        .filter(|&(key, value)| {
            process_get(key).is_some_and(|current| {
                !is_blank(&current)
                    && current.to_str().is_none_or(|current| {
                        effective(key, current, cli_cwd.unwrap_or(zzz_dir))
                            != effective(key, value, zzz_dir)
                    })
            })
        })
        .map(|(key, _)| key.to_owned())
        .collect()
}

/// Remove [`TEST_ACTIONS_ENV`] from `overlay`; returns whether it was set
/// (non-blank) in the file or the process environment.
fn strip_test_actions(
    overlay: &mut BTreeMap<String, String>,
    process_get: impl Fn(&str) -> Option<OsString>,
) -> bool {
    let from_file = overlay
        .remove(TEST_ACTIONS_ENV)
        .is_some_and(|value| !value.trim().is_empty());
    let from_process = process_get(TEST_ACTIONS_ENV).is_some_and(|value| !is_blank(&value));
    from_file || from_process
}

/// Make blank values unset: drop them from `overlay`, and list every key —
/// the ones `zzzd` reads and the ones the file names — whose value would
/// otherwise reach the child blank, for the command to `env_remove`.
fn drop_blank_values(
    overlay: &mut BTreeMap<String, String>,
    file_keys: &[String],
    process_get: impl Fn(&str) -> Option<OsString>,
) -> Vec<String> {
    overlay.retain(|_, value| !value.trim().is_empty());
    let known = REQUIRED_ENV
        .iter()
        .chain(ZZZD_ENV)
        .copied()
        .chain(PATH_VARS.iter().map(|&(key, _)| key))
        .chain(file_keys.iter().map(String::as_str));
    let mut remove: Vec<String> = known
        .filter(|key| !overlay.contains_key(*key))
        .filter(|key| process_get(key).is_some_and(|value| is_blank(&value)))
        .map(ToOwned::to_owned)
        .collect();
    remove.sort();
    remove.dedup();
    remove
}

/// Resolve [`PATH_VARS`] for the daemon's working directory (see the module
/// doc): `~` expanded everywhere; relative process-env values joined onto
/// `cli_cwd`. Rewritten values go into `overlay`, which the child's env
/// applies over the inherited one. Call before any CLI defaults are added,
/// while `overlay` holds only file values.
///
/// A non-UTF-8 process value is an error — it can't be resolved, and passing
/// it on relative would resolve against the wrong directory.
fn resolve_path_vars(
    overlay: &mut BTreeMap<String, String>,
    process_get: impl Fn(&str) -> Option<OsString>,
    cli_cwd: Option<&Path>,
) -> Result<(), CliError> {
    for &(key, is_list) in PATH_VARS {
        let resolved = if let Some(value) = overlay.get(key) {
            map_paths(value, is_list, |path| {
                fuz_sys::expand_tilde(path).to_string_lossy().into_owned()
            })
        } else if let Some(value) = process_get(key)
            .map(|value| {
                value
                    .into_string()
                    .map_err(|_| CliError::InvalidConfig(format!("{key} is not valid UTF-8")))
            })
            .transpose()?
            .filter(|value| !value.trim().is_empty())
        {
            map_paths(&value, is_list, |path| {
                let expanded = fuz_sys::expand_tilde(path);
                cli_cwd
                    .map_or_else(|| expanded.clone(), |cwd| cwd.join(&expanded))
                    .to_string_lossy()
                    .into_owned()
            })
        } else {
            continue;
        };
        overlay.insert(key.to_owned(), resolved);
    }
    Ok(())
}

/// Apply `resolve` to a path value, or to each entry of a comma-separated
/// list (entries trimmed, empty ones dropped).
fn map_paths(value: &str, is_list: bool, resolve: impl Fn(&str) -> String) -> String {
    if is_list {
        value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(resolve)
            .collect::<Vec<_>>()
            .join(",")
    } else {
        resolve(value.trim())
    }
}

/// The value the daemon will see for `key`: the overlay wins where it sets
/// one (it only holds keys the process env lacks, plus CLI defaults), else
/// the process env. Non-UTF-8 process values read as unset.
fn lookup(
    key: &str,
    process_get: impl Fn(&str) -> Option<OsString>,
    overlay: &BTreeMap<String, String>,
) -> Option<String> {
    overlay
        .get(key)
        .cloned()
        .or_else(|| process_get(key).and_then(|value| value.into_string().ok()))
}

/// `--port` > `ZZZ_PORT` (empty counts as unset) > config > default. The
/// flag and config are validated where they're parsed (argh's
/// `from_str_fn`, [`config_port`]).
fn resolve_port(
    flag: Option<u16>,
    env_value: Option<&str>,
    config: Option<u16>,
) -> Result<u16, CliError> {
    if let Some(port) = flag {
        return Ok(port);
    }
    if let Some(raw) = env_value.filter(|raw| !raw.trim().is_empty()) {
        return dl::parse_port(raw).map_err(|e| CliError::InvalidConfig(format!("ZZZ_PORT: {e}")));
    }
    Ok(config.unwrap_or(DEFAULT_PORT))
}

/// `zzz_config_port` from the CLI config, `~/.zzz/config.json` — only the
/// daemon port today; other keys are ignored. `None` when the file or the
/// key is absent (or `null`).
///
/// # Errors
///
/// [`CliError::ConfigFile`] when it can't be read, isn't a JSON object, or
/// holds anything but a port in `1..=65535`.
fn config_port(zzz_dir: &Path) -> Result<Option<u16>, CliError> {
    let path = zzz_dir.join("config.json");
    let invalid = |reason: String| CliError::ConfigFile {
        path: path.display().to_string(),
        reason,
    };
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(invalid(e.to_string())),
    };
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| invalid(e.to_string()))?;
    let object = config
        .as_object()
        .ok_or_else(|| invalid("expected a JSON object".to_owned()))?;
    let Some(value) = object
        .get("zzz_config_port")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    value
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|&port| port != 0)
        .map(Some)
        .ok_or_else(|| {
            invalid(format!(
                "zzz_config_port: expected a port in 1..=65535, got `{value}`"
            ))
        })
}

/// The UI directory: `ZZZ_STATIC_DIR` (`~`-expanded, relative to `zzz_dir`)
/// when set — it must be a directory — else `zzz_dir/static`.
fn resolve_static_dir(env_value: Option<&str>, zzz_dir: &Path) -> Result<PathBuf, CliError> {
    if let Some(raw) = env_value.map(str::trim).filter(|raw| !raw.is_empty()) {
        let path = zzz_dir.join(fuz_sys::expand_tilde(raw));
        return if path.is_dir() {
            Ok(path)
        } else {
            Err(CliError::StaticDirNotFound {
                path: path.display().to_string(),
            })
        };
    }
    let default_dir = zzz_dir.join("static");
    if default_dir.is_dir() {
        Ok(default_dir)
    } else {
        Err(CliError::NoStaticDir {
            default_dir: default_dir.display().to_string(),
        })
    }
}

/// The origins the daemon's own UI is served from.
fn default_origins(port: u16) -> String {
    format!("http://localhost:{port},http://127.0.0.1:{port}")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zzz_launch_{}_{tag}_{}",
            std::process::id(),
            fuz_sys::rand::random_hex_suffix()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn process_env_wins_over_the_file() {
        let process = |key: &str| (key == "DATABASE_URL").then(|| OsString::from("postgres://env"));
        let overlay = overlay_file_env(
            pairs(&[
                ("DATABASE_URL", "postgres://file"),
                ("SECRET_FUZ_COOKIE_KEYS", "first"),
                ("SECRET_FUZ_COOKIE_KEYS", "second"),
            ]),
            process,
        );
        assert_eq!(overlay.get("DATABASE_URL"), None);
        assert_eq!(
            overlay.get("SECRET_FUZ_COOKIE_KEYS").map(String::as_str),
            Some("second")
        );
        assert_eq!(
            lookup("DATABASE_URL", process, &overlay).as_deref(),
            Some("postgres://env")
        );
        assert_eq!(
            lookup("SECRET_FUZ_COOKIE_KEYS", process, &overlay).as_deref(),
            Some("second")
        );
        assert_eq!(lookup("UNSET", process, &overlay), None);
    }

    #[test]
    fn empty_process_values_count_as_unset() {
        let process = |key: &str| (key == "DATABASE_URL").then(OsString::new);
        let overlay = overlay_file_env(pairs(&[("DATABASE_URL", "postgres://file")]), process);
        assert_eq!(
            lookup("DATABASE_URL", process, &overlay).as_deref(),
            Some("postgres://file")
        );
    }

    #[test]
    fn path_vars_resolve_by_source() {
        let tilde = |path: &str| fuz_sys::expand_tilde(path).display().to_string();
        let process = |key: &str| match key {
            "ZZZ_STATIC_DIR" => Some(OsString::from("build")),
            "PUBLIC_ZZZ_SCOPED_DIRS" => Some(OsString::from("a, /abs ,,~/c")),
            _ => None,
        };
        // the overlay holds the file's values
        let mut overlay = BTreeMap::from([
            ("PUBLIC_ZZZ_DIR".to_owned(), "data".to_owned()),
            ("FUZ_BOOTSTRAP_TOKEN_PATH".to_owned(), "~/token".to_owned()),
            ("DATABASE_URL".to_owned(), "postgres://x".to_owned()),
        ]);
        resolve_path_vars(&mut overlay, process, Some(Path::new("/work"))).unwrap();

        // process env: relative to where `zzz` runs, `~` expanded
        assert_eq!(overlay["ZZZ_STATIC_DIR"], "/work/build");
        assert_eq!(
            overlay["PUBLIC_ZZZ_SCOPED_DIRS"],
            format!("/work/a,/abs,{}", tilde("~/c"))
        );
        // file: relative stays relative (to ~/.zzz), `~` expanded
        assert_eq!(overlay["PUBLIC_ZZZ_DIR"], "data");
        assert_eq!(overlay["FUZ_BOOTSTRAP_TOKEN_PATH"], tilde("~/token"));
        // non-path vars untouched
        assert_eq!(overlay["DATABASE_URL"], "postgres://x");
    }

    #[test]
    fn blank_values_are_removed_not_passed_on() {
        let process = |key: &str| match key {
            "PUBLIC_ZZZ_DIR" | "ZZZ_PORT" | "FROM_FILE" | "UNRELATED" => Some(OsString::from("")),
            "DATABASE_URL" => Some(OsString::from("  ")),
            "SECRET_FUZ_COOKIE_KEYS" => Some(OsString::from("set")),
            _ => None,
        };
        let mut overlay = overlay_file_env(
            pairs(&[
                ("DATABASE_URL", "postgres://file"),
                ("FROM_FILE", " "),
                ("SECRET_ANTHROPIC_API_KEY", ""),
            ]),
            process,
        );
        let file_keys = ["DATABASE_URL", "FROM_FILE", "SECRET_ANTHROPIC_API_KEY"].map(String::from);
        let removed = drop_blank_values(&mut overlay, &file_keys, process);
        // the file's value replaces a blank process value
        assert_eq!(
            overlay.get("DATABASE_URL").map(String::as_str),
            Some("postgres://file")
        );
        // blank file values are dropped, not set
        assert!(!overlay.contains_key("FROM_FILE"));
        assert!(!overlay.contains_key("SECRET_ANTHROPIC_API_KEY"));
        // blank inherited values zzzd reads, or the file names, are removed;
        // unrelated blanks are left alone
        assert_eq!(removed, ["FROM_FILE", "PUBLIC_ZZZ_DIR", "ZZZ_PORT"]);
    }

    #[test]
    fn a_non_utf8_process_path_is_an_error() {
        use std::os::unix::ffi::OsStringExt as _;
        let process =
            |key: &str| (key == "PUBLIC_ZZZ_DIR").then(|| OsString::from_vec(vec![b'a', 0xff]));
        let err =
            resolve_path_vars(&mut BTreeMap::new(), process, Some(Path::new("/w"))).unwrap_err();
        assert!(
            err.to_string()
                .contains("PUBLIC_ZZZ_DIR is not valid UTF-8"),
            "{err}"
        );
    }

    #[test]
    fn resolve_port_precedence() {
        let config = Some(5000);
        assert_eq!(
            resolve_port(Some(9999), Some("7000"), config).unwrap(),
            9999
        );
        assert_eq!(resolve_port(None, Some("7000"), config).unwrap(), 7000);
        assert_eq!(resolve_port(None, Some(" "), config).unwrap(), 5000);
        assert_eq!(resolve_port(None, None, config).unwrap(), 5000);
        assert_eq!(resolve_port(None, None, None).unwrap(), DEFAULT_PORT);
        for bad in ["http", "0", "65536"] {
            let err = resolve_port(None, Some(bad), config).unwrap_err();
            assert!(matches!(err, CliError::InvalidConfig(_)), "{err}");
            assert!(err.to_string().contains("ZZZ_PORT"), "{err}");
        }
    }

    #[test]
    fn config_port_reads_config_json() {
        let dir = temp_dir("config");
        let path = dir.join("config.json");
        assert_eq!(config_port(&dir).unwrap(), None);
        fs::write(&path, r#"{"zzz_config_port": 4999}"#).unwrap();
        assert_eq!(config_port(&dir).unwrap(), Some(4999));
        for absent in ["{}", r#"{"zzz_config_port": null}"#, r#"{"other": 1}"#] {
            fs::write(&path, absent).unwrap();
            assert_eq!(config_port(&dir).unwrap(), None, "{absent}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_config_json_is_an_error_naming_the_file() {
        let dir = temp_dir("badconfig");
        let path = dir.join("config.json");
        for (content, needle) in [
            ("{nope", ""),
            ("[4460]", "expected a JSON object"),
            (
                r#"{"zzz_config_port": 0}"#,
                "expected a port in 1..=65535, got `0`",
            ),
            (r#"{"zzz_config_port": 70000}"#, "got `70000`"),
            (r#"{"zzz_config_port": -1}"#, "got `-1`"),
            (r#"{"zzz_config_port": "4460"}"#, "got `\"4460\"`"),
        ] {
            fs::write(&path, content).unwrap();
            let err = config_port(&dir).unwrap_err();
            assert!(
                matches!(err, CliError::ConfigFile { .. }),
                "{content}: {err}"
            );
            let message = err.to_string();
            assert!(message.contains(&path.display().to_string()), "{message}");
            assert!(message.contains(needle), "{content}: {message}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overridden_file_keys_name_differing_process_values() {
        let process = |key: &str| match key {
            "DATABASE_URL" => Some(OsString::from("postgres://env")),
            "SAME" => Some(OsString::from("v")),
            "BLANK" => Some(OsString::from(" ")),
            "ZZZ_ENABLE_TEST_ACTIONS" => Some(OsString::from("1")),
            "FILE_BLANK" => Some(OsString::from("x")),
            _ => None,
        };
        let file = pairs(&[
            ("DATABASE_URL", "postgres://file"),
            ("SAME", "v"),
            ("BLANK", "file"),
            ("ZZZ_ENABLE_TEST_ACTIONS", "0"),
            ("FILE_BLANK", ""),
            ("ONLY_FILE", "f"),
        ]);
        let zzz_dir = Path::new("/home/u/.zzz");
        let keys = |file: &[(String, String)]| {
            overridden_file_keys(file, process, Some(Path::new("/work")), zzz_dir)
        };
        assert_eq!(keys(&file), ["DATABASE_URL"]);
        // the file's last line for a key is its value
        assert!(keys(&pairs(&[("SAME", "old"), ("SAME", "v")])).is_empty());
    }

    #[test]
    fn path_vars_are_compared_as_resolved_paths() {
        let home_app = fuz_sys::expand_tilde("~/app").display().to_string();
        let process = |key: &str| match key {
            // the shell expanded `$HOME/app`; the file says `~/app`: the same
            "PUBLIC_ZZZ_DIR" => Some(OsString::from(home_app.clone())),
            // the same relative value: against /work here, ~/.zzz in the file
            "ZZZ_STATIC_DIR" => Some(OsString::from("static")),
            // the file's relative entry, spelled absolute against ~/.zzz
            "PUBLIC_ZZZ_SCOPED_DIRS" => Some(OsString::from("/home/u/.zzz/a, /b")),
            _ => None,
        };
        let file = pairs(&[
            ("PUBLIC_ZZZ_DIR", "~/app"),
            ("ZZZ_STATIC_DIR", "static"),
            ("PUBLIC_ZZZ_SCOPED_DIRS", "a,/b"),
        ]);
        let zzz_dir = Path::new("/home/u/.zzz");
        assert_eq!(
            overridden_file_keys(&file, process, Some(Path::new("/work")), zzz_dir),
            ["ZZZ_STATIC_DIR"]
        );
        // with no known cwd, a relative process value resolves against
        // ~/.zzz too (as the daemon would see it)
        assert!(overridden_file_keys(&file, process, None, zzz_dir).is_empty());
    }

    #[test]
    fn test_actions_are_never_passed_on() {
        let unset = |_: &str| None;
        let set = |key: &str| (key == TEST_ACTIONS_ENV).then(|| OsString::from("1"));
        let blank = |key: &str| (key == TEST_ACTIONS_ENV).then(OsString::new);

        let mut overlay = BTreeMap::from([(TEST_ACTIONS_ENV.to_owned(), "true".to_owned())]);
        assert!(strip_test_actions(&mut overlay, unset), "set in the file");
        assert!(overlay.is_empty());
        assert!(
            strip_test_actions(&mut BTreeMap::new(), set),
            "set in the env"
        );
        assert!(
            !strip_test_actions(&mut BTreeMap::new(), blank),
            "blank is unset"
        );
        let mut overlay = BTreeMap::from([(TEST_ACTIONS_ENV.to_owned(), " ".to_owned())]);
        assert!(!strip_test_actions(&mut overlay, unset));
        assert!(overlay.is_empty());
    }

    #[test]
    fn static_dir_prefers_env_then_default() {
        let dir = temp_dir("static");

        // neither
        let err = resolve_static_dir(None, &dir).unwrap_err();
        assert!(matches!(err, CliError::NoStaticDir { .. }), "{err}");
        assert!(err.to_string().contains("static"), "{err}");

        // default
        fs::create_dir_all(dir.join("static")).unwrap();
        assert_eq!(resolve_static_dir(None, &dir).unwrap(), dir.join("static"));
        assert_eq!(
            resolve_static_dir(Some(""), &dir).unwrap(),
            dir.join("static")
        );

        // env: relative to the daemon home, and absolute
        fs::create_dir_all(dir.join("build")).unwrap();
        assert_eq!(
            resolve_static_dir(Some("build"), &dir).unwrap(),
            dir.join("build")
        );
        let absolute = dir.join("build");
        assert_eq!(
            resolve_static_dir(absolute.to_str(), Path::new("/elsewhere")).unwrap(),
            absolute
        );

        // env set but missing: an error, not a silent fallback
        let err = resolve_static_dir(Some("missing"), &dir).unwrap_err();
        assert!(matches!(err, CliError::StaticDirNotFound { .. }), "{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_env_file_missing_is_empty() {
        let dir = temp_dir("envfile");
        assert!(read_env_file(&dir.join(".env")).unwrap().is_empty());
        fs::write(dir.join(".env"), "export A=1\nB='2'\n").unwrap();
        assert_eq!(
            read_env_file(&dir.join(".env")).unwrap(),
            pairs(&[("A", "1"), ("B", "2")])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_origins_cover_the_daemon_ui() {
        assert_eq!(
            default_origins(4460),
            "http://localhost:4460,http://127.0.0.1:4460"
        );
    }
}
