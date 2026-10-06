//! Local tools the daemon runs as subprocesses (`ffmpeg`, whisper.cpp's
//! `whisper-cli`): finding the binary and running it.
//!
//! A tool is a large native program that parses whatever it's handed, so both
//! halves are narrow:
//!
//! - **Finding** ([`resolve_tool`]): an explicit override (`ZZZ_FFMPEG_BIN`,
//!   `ZZZ_WHISPER_CPP_BIN`), which must be an absolute path to an executable
//!   file — a bad one fails boot, never a fallback — else the first match on
//!   `$PATH`'s absolute entries. Never the working directory: relative
//!   `$PATH` entries are skipped, the rule the CLI uses to find `zzzd`.
//!   Resolved once at boot. A model file is never searched for: it's the
//!   explicit `ZZZ_WHISPER_CPP_MODEL` or nothing ([`resolve_model_file`]) —
//!   the same native code parses it, and zzz downloads none.
//! - **Running** ([`run_tool`]): an argument array, never a shell; standard
//!   input and output are file handles the caller opened (or nothing), so the
//!   tool needn't be given a path at all; the environment is the one
//!   terminals get ([`crate::pty_manager::terminal_env`] — no `SECRET_*`,
//!   `FUZ_*`, `ZZZ_*`, `DATABASE_URL`); the working directory is `/`; a
//!   timeout kills it; and only the tail of its stderr is kept.
//!   [`run_tool_lines`] also hands over its output a line at a time, for a
//!   tool that reports as it goes.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt as _};

use crate::pty_manager::terminal_env;

/// Env var naming the `ffmpeg` binary to run instead of the one on `$PATH`.
pub const FFMPEG_BIN_ENV: &str = "ZZZ_FFMPEG_BIN";

/// Env var naming the whisper.cpp CLI to run instead of the `whisper-cli` on
/// `$PATH`.
pub const WHISPER_CPP_BIN_ENV: &str = "ZZZ_WHISPER_CPP_BIN";

/// Env var naming the Whisper model file (`ggml-*.bin`) whisper.cpp loads.
/// There is no default and no search: without it nothing is transcribed.
pub const WHISPER_CPP_MODEL_ENV: &str = "ZZZ_WHISPER_CPP_MODEL";

/// The whisper.cpp CLI's file name.
pub const WHISPER_CPP_BIN_NAME: &str = "whisper-cli";

/// Longest output line [`run_tool_lines`] hands over; the rest of a longer
/// line is dropped.
pub const TOOL_LINE_MAX_BYTES: usize = 64 * 1024;

/// How much of a tool's stderr [`run_tool`] keeps — the tail, where a tool
/// says why it failed.
pub const TOOL_STDERR_TAIL_BYTES: usize = 16 * 1024;

/// The tools found at boot. `None` means the tool isn't installed (or isn't on
/// `$PATH`): what needs it fails when used, with [`ToolError::Unavailable`].
#[derive(Debug, Clone, Default)]
pub struct Tools {
    pub ffmpeg: Option<PathBuf>,
    /// whisper.cpp's `whisper-cli`.
    pub whisper_cpp: Option<PathBuf>,
    /// The Whisper model file whisper.cpp loads.
    pub whisper_cpp_model: Option<PathBuf>,
}

impl Tools {
    /// Resolve every tool from the process environment.
    ///
    /// # Errors
    ///
    /// A message naming the variable when an override isn't an absolute path
    /// to an executable file, the model isn't an absolute path to a file, or
    /// a value isn't valid UTF-8.
    pub fn from_env() -> Result<Self, String> {
        let path_var = std::env::var_os("PATH");
        let ffmpeg = resolve_tool(
            "ffmpeg",
            FFMPEG_BIN_ENV,
            env_override(FFMPEG_BIN_ENV)?,
            path_var.as_deref(),
            is_executable_file,
        )?;
        let whisper_cpp = resolve_tool(
            WHISPER_CPP_BIN_NAME,
            WHISPER_CPP_BIN_ENV,
            env_override(WHISPER_CPP_BIN_ENV)?,
            path_var.as_deref(),
            is_executable_file,
        )?;
        let whisper_cpp_model = resolve_model_file(
            WHISPER_CPP_MODEL_ENV,
            env_override(WHISPER_CPP_MODEL_ENV)?,
            Path::is_file,
        )?;
        Ok(Self {
            ffmpeg,
            whisper_cpp,
            whisper_cpp_model,
        })
    }

    /// whisper.cpp's CLI and the model it loads.
    ///
    /// # Errors
    ///
    /// [`ToolError::Unavailable`] when either wasn't found at boot.
    pub fn whisper_cpp(&self) -> Result<(&Path, &Path), ToolError> {
        let bin = self.whisper_cpp.as_deref().ok_or(ToolError::Unavailable {
            tool: WHISPER_CPP_BIN_NAME,
        })?;
        let model = self
            .whisper_cpp_model
            .as_deref()
            .ok_or(ToolError::Unavailable {
                tool: "a Whisper model (ZZZ_WHISPER_CPP_MODEL)",
            })?;
        Ok((bin, model))
    }

    /// The `ffmpeg` binary.
    ///
    /// # Errors
    ///
    /// [`ToolError::Unavailable`] when none was found at boot.
    pub fn ffmpeg(&self) -> Result<&Path, ToolError> {
        self.ffmpeg
            .as_deref()
            .ok_or(ToolError::Unavailable { tool: "ffmpeg" })
    }
}

/// An override variable's value: unset and blank both read as unset.
fn env_override(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} is not valid UTF-8")),
    }
}

/// Whether `path` is a regular file (following symlinks) with an execute bit.
#[must_use]
pub fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Find the binary for the tool `name`.
///
/// `override_bin` (the value of `override_env`) wins and must be an absolute
/// path to an executable file. Otherwise the first `<dir>/<name>` that is one,
/// over `path_var`'s absolute entries. `Ok(None)` when there's no override and
/// nothing on the path. `is_executable` is only ever asked about absolute
/// paths.
///
/// # Errors
///
/// A message naming `override_env` when the override is relative or isn't an
/// executable file — an explicit choice is never silently replaced by a
/// search.
pub fn resolve_tool(
    name: &str,
    override_env: &str,
    override_bin: Option<String>,
    path_var: Option<&OsStr>,
    is_executable: impl Fn(&Path) -> bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(bin) = override_bin {
        let bin = PathBuf::from(bin.trim());
        if !bin.is_absolute() {
            return Err(format!(
                "{override_env} must be an absolute path: {}",
                bin.display()
            ));
        }
        if !is_executable(&bin) {
            return Err(format!(
                "{override_env} is not an executable file: {}",
                bin.display()
            ));
        }
        return Ok(Some(bin));
    }
    Ok(path_var
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate)))
}

/// The model file named by `model` (the value of `env_name`): an absolute
/// path to a file, or `Ok(None)` when unset.
///
/// # Errors
///
/// A message naming `env_name` when the value is relative or isn't a file.
pub fn resolve_model_file(
    env_name: &str,
    model: Option<String>,
    is_file: impl Fn(&Path) -> bool,
) -> Result<Option<PathBuf>, String> {
    let Some(model) = model else {
        return Ok(None);
    };
    let model = PathBuf::from(model.trim());
    if !model.is_absolute() {
        return Err(format!(
            "{env_name} must be an absolute path: {}",
            model.display()
        ));
    }
    if !is_file(&model) {
        return Err(format!("{env_name} is not a file: {}", model.display()));
    }
    Ok(Some(model))
}

// -- Running ------------------------------------------------------------------

/// One run of a tool.
#[derive(Debug)]
pub struct ToolRun<'a> {
    /// The binary, an absolute path from [`Tools`].
    pub program: &'a Path,
    pub args: Vec<OsString>,
    /// The child's standard input — a handle the caller opened — or nothing.
    pub stdin: Option<std::fs::File>,
    /// The child's standard output, likewise. Without one it's discarded.
    pub stdout: Option<std::fs::File>,
    /// The run is killed when it takes longer.
    pub timeout: Duration,
}

/// Why a tool run didn't succeed. `stderr` is the tail of what the tool wrote
/// there — text derived from the file it was given, so untrusted.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("{tool} is not installed or not on the daemon's PATH")]
    Unavailable { tool: &'static str },
    #[error("failed to run {program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{program} timed out after {}s", timeout.as_secs())]
    TimedOut {
        program: String,
        timeout: Duration,
        stderr: String,
    },
    #[error("{program} failed ({status})")]
    Failed {
        program: String,
        status: ExitStatus,
        stderr: String,
    },
}

/// A line of a running tool's output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolLine<'a> {
    Stdout(&'a str),
    Stderr(&'a str),
}

/// Run a tool to completion.
///
/// The child is killed if it outlives `run.timeout`, and if this future is
/// dropped (a cancelled request or job) — it never outlives its caller.
///
/// # Errors
///
/// [`ToolError::Spawn`] when it can't be started or waited on,
/// [`ToolError::TimedOut`], or [`ToolError::Failed`] for a non-zero exit
/// (carrying the tail of its stderr).
pub async fn run_tool(run: ToolRun<'_>) -> Result<(), ToolError> {
    let stdout = run.stdout.map_or_else(Stdio::null, Stdio::from);
    run_child(
        run.program,
        &run.args,
        run.stdin,
        stdout,
        run.timeout,
        |_| {},
    )
    .await
}

/// Run a tool to completion, handing `on_line` each line of its output.
///
/// Every line it writes to stdout and stderr, as it's written — for a tool
/// that reports progress or results as it goes. `run.stdout` is ignored:
/// stdout is read here.
///
/// Lines end at `\n` (a trailing `\r` is dropped), invalid UTF-8 is replaced,
/// and a line is cut at [`TOOL_LINE_MAX_BYTES`]. The tail of stderr is still
/// kept for a failure.
///
/// # Errors
///
/// As [`run_tool`].
pub async fn run_tool_lines(
    run: ToolRun<'_>,
    on_line: impl FnMut(ToolLine<'_>),
) -> Result<(), ToolError> {
    run_child(
        run.program,
        &run.args,
        run.stdin,
        Stdio::piped(),
        run.timeout,
        on_line,
    )
    .await
}

async fn run_child(
    program: &Path,
    args: &[OsString],
    stdin: Option<std::fs::File>,
    stdout: Stdio,
    timeout: Duration,
    mut on_line: impl FnMut(ToolLine<'_>),
) -> Result<(), ToolError> {
    let program_name = program.display().to_string();
    let spawn_error = |source| ToolError::Spawn {
        program: program_name.clone(),
        source,
    };

    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(terminal_env(std::env::vars_os()))
        .current_dir("/")
        .stdin(stdin.map_or_else(Stdio::null, Stdio::from))
        .stdout(stdout)
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(spawn_error)?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let finished = tokio::time::timeout(timeout, async {
        // drain both pipes while waiting, or a chatty tool blocks on a full one
        let mut stdout_lines = LineSplitter::default();
        let mut stderr_lines = LineSplitter::default();
        let mut tail: Vec<u8> = Vec::new();
        let mut stdout_chunk = [0_u8; 4096];
        let mut stderr_chunk = [0_u8; 4096];
        while stdout.is_some() || stderr.is_some() {
            tokio::select! {
                read = read_some(&mut stdout, &mut stdout_chunk) => match read {
                    Some(read) => stdout_lines.push(&stdout_chunk[..read], |line| {
                        on_line(ToolLine::Stdout(line));
                    }),
                    None => stdout = None,
                },
                read = read_some(&mut stderr, &mut stderr_chunk) => match read {
                    Some(read) => {
                        let chunk = &stderr_chunk[..read];
                        keep_tail(&mut tail, chunk);
                        stderr_lines.push(chunk, |line| on_line(ToolLine::Stderr(line)));
                    }
                    None => stderr = None,
                },
            }
        }
        stdout_lines.finish(|line| on_line(ToolLine::Stdout(line)));
        stderr_lines.finish(|line| on_line(ToolLine::Stderr(line)));
        let status = child.wait().await?;
        if tail.len() > TOOL_STDERR_TAIL_BYTES {
            tail.drain(..tail.len() - TOOL_STDERR_TAIL_BYTES);
        }
        Ok::<_, std::io::Error>((status, String::from_utf8_lossy(&tail).trim().to_owned()))
    })
    .await;

    match finished {
        Ok(Ok((status, _))) if status.success() => Ok(()),
        Ok(Ok((status, stderr))) => Err(ToolError::Failed {
            program: program_name,
            status,
            stderr,
        }),
        Ok(Err(source)) => Err(spawn_error(source)),
        Err(_elapsed) => {
            // `kill_on_drop` would get it too; this reaps it as well
            if let Err(e) = child.kill().await {
                tracing::warn!(program = %program_name, error = %e, "failed to kill a timed-out tool");
            }
            Err(ToolError::TimedOut {
                program: program_name,
                timeout,
                // the readers were dropped with the timed-out future
                stderr: String::new(),
            })
        }
    }
}

/// Read once from an open pipe: `Some(n)` bytes, or `None` at its end (or on
/// an error, which ends it the same). Pends forever on a closed pipe, so a
/// `select!` over two pipes keeps reading the other.
async fn read_some<R: AsyncRead + Unpin>(pipe: &mut Option<R>, chunk: &mut [u8]) -> Option<usize> {
    let Some(reader) = pipe.as_mut() else {
        return std::future::pending().await;
    };
    match reader.read(chunk).await {
        Ok(0) | Err(_) => None,
        Ok(read) => Some(read),
    }
}

/// Append `chunk` to `tail`, keeping the last [`TOOL_STDERR_TAIL_BYTES`].
fn keep_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > TOOL_STDERR_TAIL_BYTES * 2 {
        tail.drain(..tail.len() - TOOL_STDERR_TAIL_BYTES);
    }
}

/// Splits a byte stream into lines, each cut at [`TOOL_LINE_MAX_BYTES`].
#[derive(Debug, Default)]
struct LineSplitter {
    line: Vec<u8>,
}

impl LineSplitter {
    /// Feed `chunk`, handing `emit` each line it completes.
    fn push(&mut self, chunk: &[u8], mut emit: impl FnMut(&str)) {
        for &byte in chunk {
            if byte == b'\n' {
                self.emit(&mut emit);
            } else if self.line.len() < TOOL_LINE_MAX_BYTES {
                self.line.push(byte);
            }
        }
    }

    /// The stream ended: hand over a last line that had no newline.
    fn finish(&mut self, mut emit: impl FnMut(&str)) {
        if !self.line.is_empty() {
            self.emit(&mut emit);
        }
    }

    fn emit(&mut self, emit: &mut impl FnMut(&str)) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        emit(&String::from_utf8_lossy(&self.line));
        self.line.clear();
    }
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

    fn resolve(
        override_bin: Option<&str>,
        path_var: Option<&str>,
        executables: &[&str],
    ) -> Result<Option<PathBuf>, String> {
        resolve_tool(
            "ffmpeg",
            FFMPEG_BIN_ENV,
            override_bin.map(str::to_owned),
            path_var.map(OsStr::new),
            |path| executables.contains(&path.to_str().unwrap()),
        )
    }

    #[test]
    fn the_first_absolute_path_entry_wins() {
        let found = resolve(
            None,
            Some("/missing:/usr/bin:/opt/bin"),
            &["/usr/bin/ffmpeg", "/opt/bin/ffmpeg"],
        );
        assert_eq!(found.unwrap(), Some(PathBuf::from("/usr/bin/ffmpeg")));
    }

    #[test]
    fn relative_path_entries_are_never_searched() {
        // `.`, an empty entry, and `bin` all mean "relative to the working
        // directory", which the daemon must never run a tool from
        let found = resolve(
            None,
            Some(".::bin:/usr/bin"),
            &["./ffmpeg", "ffmpeg", "bin/ffmpeg", "/usr/bin/ffmpeg"],
        );
        assert_eq!(found.unwrap(), Some(PathBuf::from("/usr/bin/ffmpeg")));
        assert_eq!(
            resolve(None, Some(".:bin"), &["./ffmpeg", "bin/ffmpeg"]).unwrap(),
            None
        );
    }

    #[test]
    fn nothing_found_is_not_an_error() {
        assert_eq!(resolve(None, Some("/usr/bin"), &[]).unwrap(), None);
        assert_eq!(resolve(None, None, &["/usr/bin/ffmpeg"]).unwrap(), None);
    }

    #[test]
    fn an_override_wins_and_is_never_replaced_by_a_search() {
        let found = resolve(
            Some(" /opt/ffmpeg/bin/ffmpeg "),
            Some("/usr/bin"),
            &["/opt/ffmpeg/bin/ffmpeg", "/usr/bin/ffmpeg"],
        );
        assert_eq!(
            found.unwrap(),
            Some(PathBuf::from("/opt/ffmpeg/bin/ffmpeg"))
        );

        let missing = resolve(Some("/opt/nope"), Some("/usr/bin"), &["/usr/bin/ffmpeg"]);
        assert!(
            missing
                .as_ref()
                .is_err_and(|e| e.contains(FFMPEG_BIN_ENV) && e.contains("/opt/nope")),
            "{missing:?}"
        );

        let relative = resolve(Some("bin/ffmpeg"), None, &["bin/ffmpeg"]);
        assert!(
            relative
                .as_ref()
                .is_err_and(|e| e.contains("absolute path")),
            "{relative:?}"
        );
    }

    fn sh(script: &str, timeout: Duration) -> ToolRun<'static> {
        ToolRun {
            program: Path::new("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            stdin: None,
            stdout: None,
            timeout,
        }
    }

    const LONG: Duration = Duration::from_secs(30);

    #[tokio::test]
    async fn a_successful_run_returns_ok() {
        run_tool(sh("exit 0", LONG)).await.unwrap();
    }

    #[tokio::test]
    async fn a_failed_run_carries_its_status_and_stderr() {
        let result = run_tool(sh("echo why >&2; exit 3", LONG)).await;
        let Err(ToolError::Failed { status, stderr, .. }) = result else {
            panic!("{result:?}");
        };
        assert_eq!(status.code(), Some(3));
        assert_eq!(stderr, "why");
    }

    #[tokio::test]
    async fn only_the_tail_of_stderr_is_kept() {
        // far more than a pipe holds, so an undrained stderr would hang it
        let script = "i=0; while [ $i -lt 20000 ]; do echo \"line $i padding padding\" >&2; i=$((i+1)); done; echo last >&2; exit 1";
        let result = run_tool(sh(script, LONG)).await;
        let Err(ToolError::Failed { stderr, .. }) = result else {
            panic!("{result:?}");
        };
        assert!(stderr.len() <= TOOL_STDERR_TAIL_BYTES, "{}", stderr.len());
        assert!(stderr.ends_with("last"), "{stderr:?}");
    }

    #[tokio::test]
    async fn a_run_past_its_timeout_is_killed() {
        let started = std::time::Instant::now();
        let result = run_tool(sh("sleep 30", Duration::from_millis(200))).await;
        assert!(
            matches!(result, Err(ToolError::TimedOut { .. })),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn a_missing_program_fails_to_spawn() {
        let result = run_tool(ToolRun {
            program: Path::new("/nonexistent/tool"),
            args: vec![],
            stdin: None,
            stdout: None,
            timeout: LONG,
        })
        .await;
        assert!(matches!(result, Err(ToolError::Spawn { .. })), "{result:?}");
    }

    #[tokio::test]
    async fn stdin_and_stdout_are_the_given_handles() {
        let dir = std::env::temp_dir().join(format!("zzz-tool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in");
        let output = dir.join("out");
        std::fs::write(&input, "through").unwrap();
        let mut run = sh("cat", LONG);
        run.stdin = Some(std::fs::File::open(&input).unwrap());
        run.stdout = Some(std::fs::File::create(&output).unwrap());
        run_tool(run).await.unwrap();
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "through");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_model_is_an_explicit_absolute_file_or_nothing() {
        let is_file = |path: &Path| path == Path::new("/models/ggml-base.bin");
        assert_eq!(
            resolve_model_file(WHISPER_CPP_MODEL_ENV, None, is_file).unwrap(),
            None
        );
        assert_eq!(
            resolve_model_file(
                WHISPER_CPP_MODEL_ENV,
                Some(" /models/ggml-base.bin ".to_owned()),
                is_file
            )
            .unwrap(),
            Some(PathBuf::from("/models/ggml-base.bin"))
        );
        for bad in ["models/ggml-base.bin", "/models/missing.bin", "/models"] {
            let result = resolve_model_file(WHISPER_CPP_MODEL_ENV, Some(bad.to_owned()), is_file);
            assert!(
                result
                    .as_ref()
                    .is_err_and(|e| e.contains(WHISPER_CPP_MODEL_ENV)),
                "{bad}: {result:?}"
            );
        }
    }

    #[test]
    fn lines_split_across_chunks_and_are_bounded() {
        let mut splitter = LineSplitter::default();
        let mut lines: Vec<String> = Vec::new();
        let mut emit = |line: &str| lines.push(line.to_owned());
        splitter.push(b"first\nsec", &mut emit);
        splitter.push(b"ond\r\n\nthi", &mut emit);
        splitter.push(b"rd", &mut emit);
        splitter.finish(&mut emit);
        assert_eq!(lines, ["first", "second", "", "third"]);

        // invalid UTF-8 is replaced, and an endless line is cut
        let mut splitter = LineSplitter::default();
        let mut lines: Vec<String> = Vec::new();
        let mut emit = |line: &str| lines.push(line.to_owned());
        splitter.push(b"bad \xff byte\n", &mut emit);
        splitter.push(&vec![b'x'; TOOL_LINE_MAX_BYTES + 100], &mut emit);
        splitter.push(b"\nnext\n", &mut emit);
        assert_eq!(lines[0], "bad \u{fffd} byte");
        assert_eq!(lines[1].len(), TOOL_LINE_MAX_BYTES);
        assert_eq!(lines[2], "next");
    }

    #[tokio::test]
    async fn lines_arrive_from_both_streams_as_they_are_written() {
        let mut lines: Vec<String> = Vec::new();
        let script = "echo one; echo warn >&2; sleep 0.05; echo two; printf last";
        run_tool_lines(sh(script, LONG), |line| {
            lines.push(match line {
                ToolLine::Stdout(text) => format!("out:{text}"),
                ToolLine::Stderr(text) => format!("err:{text}"),
            });
        })
        .await
        .unwrap();
        let out: Vec<&String> = lines.iter().filter(|l| l.starts_with("out:")).collect();
        assert_eq!(out, ["out:one", "out:two", "out:last"]);
        assert!(lines.contains(&"err:warn".to_owned()), "{lines:?}");
    }

    #[tokio::test]
    async fn a_failed_line_run_still_carries_its_stderr_tail() {
        let mut seen = 0;
        let result =
            run_tool_lines(sh("echo out; echo why >&2; exit 4", LONG), |_| seen += 1).await;
        let Err(ToolError::Failed { status, stderr, .. }) = result else {
            panic!("{result:?}");
        };
        assert_eq!(status.code(), Some(4));
        assert_eq!(stderr, "why");
        assert_eq!(seen, 2);
    }

    #[tokio::test]
    async fn the_child_gets_a_scrubbed_environment_and_the_root_as_its_directory() {
        let dir = std::env::temp_dir().join(format!("zzz-tool-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("out");
        // `DATABASE_URL` is set for every test process that reaches the DB
        // config; the names below are scrubbed whether or not they're set
        let mut run = sh("pwd; env", LONG);
        run.stdout = Some(std::fs::File::create(&output).unwrap());
        run_tool(run).await.unwrap();
        let printed = std::fs::read_to_string(&output).unwrap();
        assert_eq!(printed.lines().next(), Some("/"));
        for line in printed.lines().skip(1) {
            let name = line.split('=').next().unwrap();
            assert!(
                !name.starts_with("SECRET_")
                    && !name.starts_with("FUZ_")
                    && !name.starts_with("ZZZ_")
                    && name != "DATABASE_URL",
                "{name} leaked into a tool's environment"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
