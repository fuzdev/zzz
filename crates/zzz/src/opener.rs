//! The opener: an open command `zzz` runs with the daemon's URL, in place of
//! the browser.
//!
//! **Sources.** `opener` in `~/.zzz/config.json`, then `ZZZ_OPENER` in the
//! CLI's environment (never `~/.zzz/.env`, which is the daemon's). With
//! neither, `zzz` opens the browser. A blank (empty or whitespace) value —
//! or a `null` in the config — reads as unset and falls through to the next
//! source.
//!
//! **Shape.** In the config, a JSON string is the program alone, and a JSON
//! array of strings is the program followed by its arguments — so flags need
//! no shell parsing. Anything else is a config error naming the file: another
//! JSON type, an empty array, a non-string element, or a blank program (the
//! array's first element — it's an error rather than "unset", since an array
//! that has arguments but no program is a mistake, not an absent setting).
//! `ZZZ_OPENER` is the program alone, never split. Arguments are passed on
//! verbatim, blank ones included.
//!
//! **Program.** Surrounding whitespace is trimmed and a leading `~` expands;
//! a relative path resolves against `~/.zzz` when it comes from `config.json`
//! and against the directory `zzz` runs in when it comes from `ZZZ_OPENER`
//! (where each was written, as for the daemon's path-valued variables). A
//! **bare name** — no `/` (`~` alone aside), so `~name` too, since only `~`
//! and `~/…` expand — is refused from both sources: `$PATH` is not searched,
//! and resolving it as a relative path would run whatever executable of that
//! name sits in the directory `zzz` happens to run in (an untrusted checkout,
//! say). A file there is written `./name`. The program must be an executable
//! file: one that isn't is an error ([`CliError::OpenerNotExecutable`], as is
//! a bare name), never a fallback to the browser.
//!
//! **Launch.** The URL is appended as the final argument and the program is
//! executed directly — no shell ever sees the URL or the arguments. The URL
//! is always an argument of its own, so a program that wants it inside
//! another (`--flag=<url>`) needs a wrapper script. It runs detached
//! ([`dl::spawn_detached`]) in the directory `zzz` runs in, with its output
//! in `~/.zzz/run/opener.log` (emptied at each launch), and is not awaited:
//! `zzz` can't tell a launcher that exits at once from a window that stays
//! open, so the opener's own exit status is not checked. Its environment is
//! the CLI's, minus `ZZZ_ENABLE_TEST_ACTIONS` (as for a daemon the CLI
//! starts) — the daemon's `~/.zzz/.env` values are not added.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use crate::CliError;
use crate::daemon_launch::{CliConfig, TEST_ACTIONS_ENV};
use crate::daemon_lifecycle as dl;

/// The env var naming an opener program.
pub const OPENER_ENV: &str = "ZZZ_OPENER";

/// The `config.json` key holding the opener.
pub const OPENER_CONFIG_KEY: &str = "opener";

/// A configured opener, resolved and checked.
#[derive(Debug, PartialEq, Eq)]
pub struct Opener {
    /// The program, an absolute path to an executable file.
    pub program: PathBuf,
    /// Its arguments, before the URL.
    pub args: Vec<String>,
}

impl Opener {
    /// The configured opener, if any, from `config` (the `config.json` of
    /// `zzz_dir`, `None` when there is no file) and the environment.
    ///
    /// # Errors
    ///
    /// [`CliError::ConfigFile`] for a malformed `opener`;
    /// [`CliError::OpenerNotExecutable`] when the program is a bare name or
    /// isn't an executable file.
    pub fn resolve(config: Option<&CliConfig>, zzz_dir: &Path) -> Result<Option<Self>, CliError> {
        find_opener(
            config,
            std::env::var_os(OPENER_ENV),
            zzz_dir,
            std::env::current_dir().ok().as_deref(),
            dl::is_executable_file,
        )
    }

    /// The command opening `url`: the program, its arguments, then `url` as
    /// the final argument; stdio left to the caller.
    #[must_use]
    pub fn command(&self, url: &str) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command
            .args(&self.args)
            .arg(url)
            .env_remove(TEST_ACTIONS_ENV);
        command
    }

    /// Run the opener on `url`, detached, with its output captured to
    /// `zzz_dir/run/opener.log` (mode `0600`, emptied per launch). Returns
    /// once it's spawned.
    pub fn launch(&self, url: &str, zzz_dir: &Path) -> Result<(), CliError> {
        let run_dir = zzz_dir.join("run");
        fs::create_dir_all(&run_dir)?;
        let log = dl::create_private_log(&run_dir.join("opener.log"))?;
        let child = dl::spawn_detached(&mut self.command(url), log).map_err(|e| {
            CliError::OpenerSpawnFailed {
                path: self.program.display().to_string(),
                reason: e.to_string(),
            }
        })?;
        // never awaited (std does not kill on drop): the opener outlives
        // this CLI process
        drop(child);
        Ok(())
    }
}

/// The search behind [`Opener::resolve`], with its inputs injected.
/// `is_executable` is only ever asked about absolute paths.
fn find_opener(
    config: Option<&CliConfig>,
    env_value: Option<OsString>,
    zzz_dir: &Path,
    cli_cwd: Option<&Path>,
    is_executable: impl Fn(&Path) -> bool,
) -> Result<Option<Opener>, CliError> {
    let checked = |raw: &OsStr, base: Option<&Path>, args: Vec<String>, origin: String| {
        let refused = |path: String| Err(CliError::OpenerNotExecutable { origin, path });
        if is_bare_name(raw) {
            // as written: it names no path
            return refused(raw.to_string_lossy().trim().to_owned());
        }
        let program = resolve_program(raw, base);
        if program.is_absolute() && is_executable(&program) {
            Ok(Some(Opener { program, args }))
        } else {
            refused(program.display().to_string())
        }
    };
    if let Some(config) = config
        && let Some(value) = config.object.get(OPENER_CONFIG_KEY)
        && let Some((program, args)) = parse_config_opener(value)
            .map_err(|reason| config.invalid(format!("{OPENER_CONFIG_KEY}: {reason}")))?
    {
        return checked(
            OsStr::new(&program),
            Some(zzz_dir),
            args,
            format!("`{OPENER_CONFIG_KEY}` in {}", config.path.display()),
        );
    }
    let Some(program) = env_value.filter(|value| !value.to_string_lossy().trim().is_empty()) else {
        return Ok(None);
    };
    checked(&program, cli_cwd, Vec::new(), OPENER_ENV.to_owned())
}

/// Parse the config's `opener` value into the program (as written) and its
/// arguments. `Ok(None)` when it reads as unset: `null`, or a blank string.
///
/// The `Err` is the reason, for a [`CliError::ConfigFile`].
fn parse_config_opener(value: &serde_json::Value) -> Result<Option<(String, Vec<String>)>, String> {
    use serde_json::Value;

    match value {
        Value::Null => Ok(None),
        Value::String(program) if program.trim().is_empty() => Ok(None),
        Value::String(program) => Ok(Some((program.clone(), Vec::new()))),
        Value::Array(items) => {
            let mut argv = items.iter().map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    format!("expected an array of strings, got the element `{item}`")
                })
            });
            let program = argv
                .next()
                .ok_or("expected a program, got an empty array")??;
            if program.trim().is_empty() {
                return Err("the program (the array's first element) is blank".to_owned());
            }
            Ok(Some((program, argv.collect::<Result<_, _>>()?)))
        }
        other => Err(format!(
            "expected a program path or an array of strings, got `{other}`"
        )),
    }
}

/// Whether a program value is a bare name: no `/` (surrounding whitespace
/// aside). Refused rather than resolved — see the module doc. `~` alone is
/// the one exception (it expands to the home directory, then fails as not an
/// executable file); `~name` is a bare name, since only `~` and `~/…` expand.
fn is_bare_name(raw: &OsStr) -> bool {
    let bytes = raw.as_encoded_bytes().trim_ascii();
    !bytes.contains(&b'/') && bytes != b"~"
}

/// The opener program as an absolute path, where `base` is known: a leading
/// `~` expanded (surrounding whitespace dropped), then joined onto `base`,
/// the directory a relative value was written against. A non-UTF-8 value is
/// taken as is — no `~`, no trimming.
fn resolve_program(raw: &OsStr, base: Option<&Path>) -> PathBuf {
    let expanded = raw.to_str().map_or_else(
        || PathBuf::from(raw),
        |raw| fuz_sys::expand_tilde(raw.trim()),
    );
    base.map_or_else(|| expanded.clone(), |base| base.join(&expanded))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use serde_json::json;

    use super::*;

    const ZZZ_DIR: &str = "/home/u/.zzz";
    const CLI_CWD: &str = "/work";

    fn config(opener: &serde_json::Value) -> CliConfig {
        let serde_json::Value::Object(object) =
            json!({ "zzz_config_port": 4460, "opener": opener })
        else {
            unreachable!()
        };
        CliConfig {
            path: PathBuf::from("/home/u/.zzz/config.json"),
            object,
        }
    }

    /// `find_opener` where every absolute path is executable.
    fn find(
        opener: Option<&serde_json::Value>,
        env_value: Option<&str>,
    ) -> Result<Option<Opener>, CliError> {
        find_opener(
            opener.map(config).as_ref(),
            env_value.map(OsString::from),
            Path::new(ZZZ_DIR),
            Some(Path::new(CLI_CWD)),
            |path| {
                assert!(path.is_absolute(), "asked about {}", path.display());
                true
            },
        )
    }

    fn opener(program: &str, args: &[&str]) -> Opener {
        Opener {
            program: PathBuf::from(program),
            args: args.iter().map(|&arg| arg.to_owned()).collect(),
        }
    }

    #[test]
    fn neither_source_means_the_browser() {
        assert_eq!(find(None, None).unwrap(), None);
        // a config without the key
        let no_key = CliConfig {
            path: PathBuf::from("/c.json"),
            object: serde_json::Map::new(),
        };
        let found = find_opener(Some(&no_key), None, Path::new(ZZZ_DIR), None, |_| true);
        assert_eq!(found.unwrap(), None);
    }

    #[test]
    fn a_config_string_is_the_program_alone() {
        // never split, whatever it holds
        assert_eq!(
            find(Some(&json!("/opt/my app --flag")), None).unwrap(),
            Some(opener("/opt/my app --flag", &[]))
        );
    }

    #[test]
    fn a_config_array_is_the_program_and_its_arguments() {
        assert_eq!(
            find(Some(&json!(["/opt/app", "--new-window", "a b", ""])), None).unwrap(),
            Some(opener("/opt/app", &["--new-window", "a b", ""]))
        );
        assert_eq!(
            find(Some(&json!(["/opt/app"])), None).unwrap(),
            Some(opener("/opt/app", &[]))
        );
    }

    #[test]
    fn the_config_beats_the_environment() {
        assert_eq!(
            find(Some(&json!(["/opt/app", "-x"])), Some("/env/app")).unwrap(),
            Some(opener("/opt/app", &["-x"]))
        );
        assert_eq!(
            find(None, Some("/env/app --not-split")).unwrap(),
            Some(opener("/env/app --not-split", &[]))
        );
    }

    #[test]
    fn blank_values_read_as_unset() {
        for blank in [json!(null), json!(""), json!("  \t")] {
            assert_eq!(
                find(Some(&blank), Some("/env/app")).unwrap(),
                Some(opener("/env/app", &[])),
                "{blank}"
            );
            assert_eq!(find(Some(&blank), None).unwrap(), None, "{blank}");
        }
        for blank in ["", "  "] {
            assert_eq!(find(None, Some(blank)).unwrap(), None, "{blank:?}");
            assert_eq!(
                find(Some(&json!("/opt/app")), Some(blank)).unwrap(),
                Some(opener("/opt/app", &[]))
            );
        }
    }

    #[test]
    fn a_malformed_config_opener_is_an_error_naming_the_file() {
        for (value, needle) in [
            (
                json!(5),
                "expected a program path or an array of strings, got `5`",
            ),
            (json!(true), "got `true`"),
            (json!({"program": "/opt/app"}), "expected a program path"),
            (json!([]), "expected a program, got an empty array"),
            (
                json!(["/opt/app", 5]),
                "expected an array of strings, got the element `5`",
            ),
            (json!([null, "-x"]), "got the element `null`"),
            (json!([["/opt/app"]]), "expected an array of strings"),
            (
                json!(["", "-x"]),
                "the program (the array's first element) is blank",
            ),
            (json!([" "]), "is blank"),
        ] {
            // the environment is no fallback for a bad config
            let err = find(Some(&value), Some("/env/app")).unwrap_err();
            assert!(matches!(err, CliError::ConfigFile { .. }), "{value}: {err}");
            let message = err.to_string();
            assert!(
                message.starts_with("invalid /home/u/.zzz/config.json: opener: "),
                "{message}"
            );
            assert!(message.contains(needle), "{value}: {message}");
            assert_eq!(err.exit_code(), 2);
        }
    }

    #[test]
    fn a_relative_path_resolves_by_source() {
        // config: against ~/.zzz
        assert_eq!(
            find(Some(&json!("bin/app")), None).unwrap(),
            Some(opener("/home/u/.zzz/bin/app", &[]))
        );
        assert_eq!(
            find(Some(&json!(["./app", "-x"])), None).unwrap(),
            Some(opener("/home/u/.zzz/./app", &["-x"]))
        );
        // env: against the directory zzz runs in
        assert_eq!(
            find(None, Some("tools/app")).unwrap(),
            Some(opener("/work/tools/app", &[]))
        );
        assert_eq!(
            find(None, Some("./app")).unwrap(),
            Some(opener("/work/./app", &[]))
        );
        // surrounding whitespace is dropped from the program
        assert_eq!(
            find(None, Some(" /env/app ")).unwrap(),
            Some(opener("/env/app", &[]))
        );
        assert_eq!(
            find(Some(&json!(" bin/app ")), None).unwrap(),
            Some(opener("/home/u/.zzz/bin/app", &[]))
        );
    }

    #[test]
    fn a_bare_name_is_refused_from_both_sources() {
        // `find` calls every absolute path executable: a bare name is refused
        // without being resolved against anything, or looked up on $PATH
        for (value, env_value, expected) in [
            (
                Some(json!("app")),
                Some("/env/app"),
                "`opener` in /home/u/.zzz/config.json is not an executable file: app",
            ),
            (
                Some(json!([" app ", "-x"])),
                None,
                "`opener` in /home/u/.zzz/config.json is not an executable file: app",
            ),
            (
                None,
                Some("app"),
                "ZZZ_OPENER is not an executable file: app",
            ),
            (
                None,
                Some(" my app "),
                "ZZZ_OPENER is not an executable file: my app",
            ),
            // only `~` and `~/…` expand: `~foo` is a bare name too
            (
                None,
                Some("~foo"),
                "ZZZ_OPENER is not an executable file: ~foo",
            ),
            (
                Some(json!("~foo")),
                None,
                "`opener` in /home/u/.zzz/config.json is not an executable file: ~foo",
            ),
        ] {
            let err = find(value.as_ref(), env_value).unwrap_err();
            assert!(matches!(err, CliError::OpenerNotExecutable { .. }), "{err}");
            assert_eq!(err.to_string(), expected);
            assert_eq!(err.exit_code(), 2);
            assert!(err.hint().is_some_and(|hint| hint.contains("`./name`")));
        }
        for name in ["app", ".", "~foo", " ~foo ", "~~"] {
            assert!(is_bare_name(OsStr::new(name)), "{name}");
        }
        for path in [
            "./app", "bin/app", "/app", "~/app", "~", " ~ ", " ~/app", "~foo/app",
        ] {
            assert!(!is_bare_name(OsStr::new(path)), "{path}");
        }
    }

    #[test]
    fn a_tilde_expands_from_both_sources() {
        let home_app = fuz_sys::expand_tilde("~/bin/app");
        let expected = Some(Opener {
            program: Path::new(ZZZ_DIR).join(&home_app),
            args: Vec::new(),
        });
        assert_eq!(find(Some(&json!("~/bin/app")), None).unwrap(), expected);
        let expected = Some(Opener {
            program: Path::new(CLI_CWD).join(&home_app),
            args: Vec::new(),
        });
        assert_eq!(find(None, Some("~/bin/app")).unwrap(), expected);
    }

    #[test]
    fn a_program_that_is_not_executable_is_an_error_not_a_fallback() {
        let find = |opener: Option<&serde_json::Value>, env_value: Option<&str>| {
            find_opener(
                opener.map(config).as_ref(),
                env_value.map(OsString::from),
                Path::new(ZZZ_DIR),
                Some(Path::new(CLI_CWD)),
                |_| false,
            )
        };
        let err = find(Some(&json!(["bin/app", "-x"])), Some("/env/app")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "`opener` in /home/u/.zzz/config.json is not an executable file: /home/u/.zzz/bin/app"
        );
        assert_eq!(err.exit_code(), 2);
        let err = find(None, Some("tools/app")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "ZZZ_OPENER is not an executable file: /work/tools/app"
        );
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn a_relative_program_with_no_known_directory_is_an_error() {
        let found = find_opener(
            None,
            Some("./app".into()),
            Path::new(ZZZ_DIR),
            None,
            |path| {
                assert!(path.is_absolute(), "asked about {}", path.display());
                true
            },
        );
        assert!(
            matches!(found, Err(CliError::OpenerNotExecutable { .. })),
            "{found:?}"
        );
    }

    #[test]
    fn the_url_is_the_final_argument_and_test_actions_are_removed() {
        let opener = Opener {
            program: PathBuf::from("/opt/app"),
            args: vec!["--flag".to_owned(), "a b".to_owned()],
        };
        let url = "http://localhost:4460/workspaces?workspace=%2Fa%20b%2F";
        let command = opener.command(url);
        assert_eq!(command.get_program(), "/opt/app");
        let args: Vec<&OsStr> = command.get_args().collect();
        assert_eq!(args, ["--flag", "a b", url]);
        let envs: Vec<_> = command.get_envs().collect();
        assert_eq!(envs, [(OsStr::new(TEST_ACTIONS_ENV), None)]);
    }
}
