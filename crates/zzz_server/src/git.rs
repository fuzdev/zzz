//! The daemon's git: the environment its runner gets, and whether git is
//! usable at all.
//!
//! Every git call `zzzd` makes runs on a runner built as `App.git` is
//! ([`daemon_git`]) — project resolution's (`fuz_repos`'s discovery, the
//! `RootInEntry` check) and the boot check's among them. Its environment
//! is an allowlist
//! ([`git_env`]), not the terminal's environment minus names: the daemon's
//! own environment is whatever started it, and anything git reads from it —
//! an inherited `GIT_*` above all (`GIT_CONFIG_*`, `GIT_EXEC_PATH`,
//! `GIT_ATTR_SOURCE`, …), but also a variable a future git learns to read —
//! would otherwise steer the daemon's calls. `fuz_git`'s runner scrubs the
//! variables it knows redirect git; the allowlist makes the rest moot.
//!
//! Git is checked once at boot ([`check_git`]) and the outcome kept on `App`
//! ([`GitUsability`]), so a caller that has a fallback without git takes it
//! without spawning git to find out.

use std::ffi::OsString;
use std::path::Path;

use fuz_git::{Git, GitVersion};

/// The only variables the daemon's git runner passes on from `zzzd`'s
/// environment ([`git_env`]).
///
/// - `PATH` — where `git` itself is found, and the programs the user's own
///   config names for it (a filter driver, `!` aliases).
/// - `HOME` and `XDG_CONFIG_HOME` — where git finds the user's global config
///   and excludes file (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and
///   `git/ignore`, `core.excludesFile` with a `~`). The user's global
///   excludes are part of git's answer to what is ignored, so they stay.
///
/// No `LANG` / `LC_*`: the runner sets `LC_ALL=C`, which overrides them.
/// No `USER` / `LOGNAME`: git never reads them — an identity the config
/// doesn't name comes from passwd and `EMAIL` — and the daemon's calls
/// author nothing.
pub const GIT_ENV_ALLOWLIST: &[&str] = &["PATH", "HOME", "XDG_CONFIG_HOME"];

/// The environment the daemon's git runner gets from `vars` (`zzzd`'s):
/// the [`GIT_ENV_ALLOWLIST`] variables, nothing else (the module docs say
/// why). Names match exactly and case-sensitively.
pub fn git_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(name, _)| GIT_ENV_ALLOWLIST.iter().any(|allowed| name == allowed))
        .collect()
}

/// The daemon's git runner: `fuz_git`'s hardening over [`git_env`] of the
/// process environment.
pub fn daemon_git() -> Git {
    Git::with_clean_env(git_env(std::env::vars_os()))
}

/// Whether the daemon's git is usable, as checked once at boot
/// ([`check_git`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitUsability {
    /// git is on the runner's `PATH` and new enough.
    Usable {
        /// The version it reported.
        version: GitVersion,
    },
    /// git can't be used, and why: callers take their fallback without it.
    Unusable {
        /// What the check found, for the warning a fallback logs.
        reason: String,
    },
}

impl GitUsability {
    /// Before the boot check: unusable, so nothing relies on a git no one
    /// checked. What `App::new` starts with.
    pub fn unchecked() -> Self {
        Self::Unusable {
            reason: "git hasn't been checked".to_owned(),
        }
    }

    /// Whether git is usable.
    pub const fn is_usable(&self) -> bool {
        matches!(self, Self::Usable { .. })
    }

    /// For a test `App` whose code under test takes the git path, which
    /// [`Self::unchecked`] (`App::new`'s) never does: the boot check, run
    /// now on a runner built as `App.git` is.
    ///
    /// # Panics
    ///
    /// When this machine's git is unusable — the suite's fixtures need it
    /// anyway.
    #[cfg(test)]
    pub fn checked_for_tests() -> Self {
        let found = check_git(&daemon_git(), &std::env::temp_dir());
        assert!(found.is_usable(), "{found:?}");
        found
    }
}

/// Checks `git` once (`Git::check_version`, in `dir`), logging what it
/// found. Blocking: an async caller runs it on `spawn_blocking`.
///
/// Without a usable git the daemon still serves: discovery from a linked
/// worktree and the registry-root-in-an-entry check find nothing.
pub fn check_git(git: &Git, dir: &Path) -> GitUsability {
    match git.check_version(dir) {
        Ok(version) => {
            tracing::info!(%version, "git found");
            GitUsability::Usable { version }
        }
        Err(e) => {
            let reason = fuz_sys::cli::format_error_chain(&e);
            tracing::warn!(error = %reason, "git is unusable; zzz goes without it");
            GitUsability::Unusable { reason }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn git_env_keeps_the_allowlist_alone() {
        let kept = vars(&[
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/me"),
            ("XDG_CONFIG_HOME", "/home/me/.config"),
        ]);
        let mut input = vars(&[
            ("GIT_DIR", "/elsewhere/.git"),
            ("GIT_CONFIG_GLOBAL", "/tmp/evil"),
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_EXEC_PATH", "/tmp/bin"),
            ("SECRET_ANTHROPIC_API_KEY", "sk"),
            ("DATABASE_URL", "postgres://localhost/zzz"),
            ("LANG", "en_US.UTF-8"),
            ("SSH_AUTH_SOCK", "/run/user/1000/ssh"),
            ("USER", "me"),
            ("LOGNAME", "me"),
            ("EMAIL", "me@example.com"),
            // case-sensitive, exact
            ("path", "/tmp"),
            ("HOMEDIR", "/tmp"),
        ]);
        input.extend(kept.clone());
        assert_eq!(git_env(input), kept);
    }

    /// The runner's git sees no variable outside the allowlist, only the
    /// runner's own hardening: read back through a `!env` alias.
    #[test]
    fn the_runner_passes_nothing_outside_the_allowlist() {
        let tmp = std::env::temp_dir().join(format!("zzz_git_env_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&tmp).unwrap();
        // each value carries a marker no line git sees may hold
        let mut input = vars(&[
            ("ZZZ_GIT_ENV_PROBE", "zzzprobe"),
            ("GIT_CONFIG_PARAMETERS", "'zzzprobe.key'='x'"),
            ("GIT_ATTR_SOURCE", "zzzprobe"),
            ("SECRET_X", "zzzprobe"),
        ]);
        input.extend(std::env::vars_os().filter(|(k, _)| k == "PATH"));
        let git = Git::with_clean_env(git_env(input));
        let seen = git
            .output_string(
                &tmp,
                &["-c", "alias.zzz-env=!env", "zzz-env"],
                fuz_git::CallOptions::default(),
            )
            .unwrap();
        std::fs::remove_dir(&tmp).unwrap();
        assert!(!seen.contains("zzzprobe"), "{seen}");
        let names: Vec<&str> = seen
            .lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name))
            .collect();
        assert!(names.contains(&"PATH"), "{names:?}");
        // besides the allowlist: the runner's hardening, what git sets for
        // an alias (`GIT_*`, its own `-c`s among them), and what a shell
        // between them would
        for name in &names {
            assert!(
                GIT_ENV_ALLOWLIST.contains(name)
                    || name.starts_with("GIT_")
                    || ["LC_ALL", "PWD", "OLDPWD", "SHLVL", "_"].contains(name),
                "{name} reached git: {names:?}"
            );
        }
    }

    #[test]
    fn the_boot_check_finds_git_or_says_why_not() {
        let dir = std::env::temp_dir();
        // this machine's git is new enough: the suite's fixtures run it
        assert!(GitUsability::checked_for_tests().is_usable());

        let nowhere = Git::with_clean_env(vec![("PATH".into(), "/nonexistent".into())]);
        let GitUsability::Unusable { reason } = check_git(&nowhere, &dir) else {
            panic!("git found on a PATH holding nothing");
        };
        assert!(reason.contains("not found"), "{reason}");

        assert!(!GitUsability::unchecked().is_usable());
    }
}
