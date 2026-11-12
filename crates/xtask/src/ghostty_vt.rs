//! `cargo xtask ghostty-vt` — build libghostty-vt's WebAssembly module from
//! pinned, verified sources and install it where the frontend serves it.
//!
//! libghostty-vt is Ghostty's terminal emulator as a C library; the
//! `fuz_terminal` library (`src/lib/fuz_terminal/`) binds its wasm build.
//! The module is built here rather than downloaded prebuilt so the feature
//! set can be trimmed ([`VT_FEATURES`]), and it is never committed: it lands
//! at [`MODULE_PATH`], which is gitignored.
//!
//! The steps, in order, each refusing on failure:
//!
//! 1. **Tools** — `curl`, `tar`, `sha256sum`, and Zig 0.17.x must run (the
//!    release builds only with that Zig minor; see [`check_zig_version`]).
//! 2. **Up to date?** — the stamp in [`CACHE_DIR`] records the pinned
//!    inputs, the Zig version, and the installed module's hash; when all
//!    match, nothing else runs.
//! 3. **Fetch** — the source and dependency tarballs, into [`CACHE_DIR`].
//!    A cached tarball is reused only if its sha256 matches the pin; a
//!    download that doesn't match is deleted and refused, naming the file and
//!    both hashes. A server that doesn't connect within 30s, or a download
//!    slower than 1 KiB/s for a minute, fails the step. Both are verified
//!    before anything is unpacked.
//! 4. **Build** — both unpacked into a fresh directory, then `zig build`
//!    offline: `--system` points at the unpacked dependency tree, and
//!    `ZIG_GLOBAL_CACHE_DIR` at a new empty directory, as the release's
//!    packaging guide requires (an empty cache also proves the build used
//!    only the verified packages).
//! 5. **Install** — the module is checked to be WebAssembly, written beside
//!    [`MODULE_PATH`] under a temporary name and renamed over it, then the
//!    stamp is written the same way.
//!
//! Every run first removes any temporary file an interrupted install left
//! beside [`MODULE_PATH`] (see [`remove_stale_install_temps`]), since
//! `gro build` would ship it with the rest of `static/`.
//!
//! Every program runs directly with an argument vector — nothing passes
//! through a shell. The pins (version and tarball hashes) are constants here;
//! moving to a new release means checking its `SHA256SUMS` signature against
//! upstream's minisign key by hand and updating them.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::Result;

/// The pinned libghostty-vt release, as a literal so file names and URLs can
/// be built with `concat!`.
macro_rules! pinned_version {
    () => {
        "1.0.0"
    };
}

/// The pinned libghostty-vt release.
pub const VERSION: &str = pinned_version!();

/// Where the release files are published.
const RELEASE_URL: &str = concat!(
    "https://release.files.ghostty.org/libghostty-vt/",
    pinned_version!(),
    "/"
);

/// A release file and the sha256 it must have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PinnedFile {
    name: &'static str,
    sha256: &'static str,
}

/// The source tarball. It builds the library by default (`-Demit-lib-vt` is
/// for a git checkout).
const SOURCE_TARBALL: PinnedFile = PinnedFile {
    name: concat!("libghostty-vt-", pinned_version!(), ".tar.gz"),
    sha256: "4a6ef758be721923e1969e7b81b443dcc92d8dd3fb5a39600c03a8817a753676",
};

/// The dependency tarball: every Zig package the build needs, unpacked in the
/// layout `zig build --system` reads.
const DEPS_TARBALL: PinnedFile = PinnedFile {
    name: concat!("libghostty-vt-", pinned_version!(), "-deps.tar.gz"),
    sha256: "4d5ea5e448e4c7ea8fb55ccbaa8668f2a97d44f438cee831e2b7ecd162d85c29",
};

/// The top-level directories the two tarballs unpack to.
const SOURCE_DIR_NAME: &str = concat!("libghostty-vt-", pinned_version!());
const DEPS_DIR_NAME: &str = concat!("libghostty-vt-", pinned_version!(), "-deps");

/// The Zig minor version the pinned release builds with; any patch release
/// of it works, and no other minor does.
const ZIG_MINOR: &str = "0.17";

const ZIG_TARGET: &str = "wasm32-freestanding";
/// The packaging guide's recommendation for the web.
const ZIG_OPTIMIZE: &str = "ReleaseSmall";
/// The library's optional parts the module keeps: rendering, input
/// encoding, selection, and the formatter. Everything else is compiled out:
/// its functions stay exported but do nothing (most return
/// `GHOSTTY_UNSUPPORTED`, the rest an empty value). That includes `color`,
/// which gates only the C API's standalone color helpers (parsing color
/// strings, X11 names, palettes, contrast); the binding never calls them,
/// and the terminal's own color handling is always built in.
const VT_FEATURES: &str = "-all,+render-state,+input-encode,+selection,+formatter";

/// The build cache: tarballs, the unpacked trees, Zig's caches, the stamp.
/// Under `target/`, so it's gitignored and outside Vite's watch.
pub const CACHE_DIR: &str = "target/ghostty-vt";
/// Where the module is installed: served by Vite in dev, copied into the
/// build by `gro build`. Gitignored.
pub const MODULE_PATH: &str = "static/fuz_terminal/ghostty-vt.wasm";
/// The file in [`CACHE_DIR`] recording what the installed module was built
/// from.
const STAMP_FILE: &str = "stamp";

/// The first eight bytes of every WebAssembly binary: the magic number and
/// version 1.
const WASM_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// Build and install the module unless the installed one is current.
pub fn run() -> Result<()> {
    let started = Instant::now();
    let root = std::env::current_dir()?;
    let cache_dir = root.join(CACHE_DIR);
    let module_path = root.join(MODULE_PATH);
    let stamp_path = cache_dir.join(STAMP_FILE);
    // first, before the tool and up-to-date checks: a killed install can
    // leave one beside a module that is still current, and it would ship in a
    // build whether or not this step can run
    remove_stale_install_temps(&module_path)?;
    let zig_version = check_tools()?;

    if let Some(module_sha256) = current_module_hash(&stamp_path, &module_path, &zig_version)? {
        println!(
            "[xtask] {MODULE_PATH} is current (libghostty-vt {VERSION}, Zig {zig_version}, \
             sha256 {module_sha256}) — nothing to do"
        );
        return Ok(());
    }

    let downloads_dir = cache_dir.join("downloads");
    fs::create_dir_all(&downloads_dir)?;
    // both verified before either is unpacked
    let source_tarball = fetch_verified(&downloads_dir, SOURCE_TARBALL)?;
    let deps_tarball = fetch_verified(&downloads_dir, DEPS_TARBALL)?;

    let build_dir = cache_dir.join("build");
    let built = build_module(&build_dir, &source_tarball, &deps_tarball)?;

    let module = fs::read(&built)
        .map_err(|e| format!("can't read the built module {}: {e}", built.display()))?;
    if !module.starts_with(&WASM_HEADER) {
        return Err(format!("{} is not a WebAssembly module", built.display()).into());
    }
    write_atomically(&module_path, &module)?;
    let module_sha256 = sha256_of_file(&module_path)?;
    write_atomically(
        &stamp_path,
        stamp_text(&zig_version, &module_sha256).as_bytes(),
    )?;
    println!(
        "[xtask] installed {MODULE_PATH} (libghostty-vt {VERSION}, Zig {zig_version}, {} bytes, \
         sha256 {module_sha256}) in {:.1}s",
        module.len(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// Check that every tool this step runs is there, returning Zig's version.
fn check_tools() -> Result<String> {
    for tool in ["curl", "tar", "sha256sum"] {
        run_capturing(Command::new(tool).arg("--version"), tool)?;
    }
    let zig_version = run_capturing(Command::new("zig").arg("version"), "zig")?;
    let zig_version = zig_version.trim().to_owned();
    check_zig_version(&zig_version)?;
    Ok(zig_version)
}

/// Accept an official Zig release of the minor the pinned libghostty-vt
/// needs (`0.17.<patch>`); refuse anything else, a development build
/// included, naming what was found.
fn check_zig_version(version: &str) -> std::result::Result<(), String> {
    let accepted = version
        .strip_prefix(ZIG_MINOR)
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|patch| !patch.is_empty() && patch.bytes().all(|b| b.is_ascii_digit()));
    if accepted {
        Ok(())
    } else {
        Err(format!(
            "libghostty-vt {VERSION} builds with Zig {ZIG_MINOR}.x (an official release), but \
             `zig version` is `{version}` — install Zig {ZIG_MINOR} (https://ziglang.org/download/)"
        ))
    }
}

/// Run `command`, returning its stdout. A program that isn't there, or that
/// fails, is an error naming it and what this step needs.
fn run_capturing(command: &mut Command, program: &str) -> Result<String> {
    let output = command.stdin(Stdio::null()).output().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            format!(
                "`{program}` not found on PATH — `cargo xtask ghostty-vt` needs curl, tar, \
                 sha256sum, and Zig {ZIG_MINOR}.x"
            )
        } else {
            format!("can't run `{program}`: {e}")
        }
    })?;
    if !output.status.success() {
        return Err(format!(
            "`{program}` failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| format!("`{program}` printed output that isn't UTF-8").into())
}

/// The stamp recording what the installed module was built from: the pinned
/// inputs, the Zig that built it, and the module's own hash.
fn stamp_text(zig_version: &str, module_sha256: &str) -> String {
    format!(
        "libghostty_vt_version={VERSION}\n\
         source_sha256={}\n\
         deps_sha256={}\n\
         zig_version={zig_version}\n\
         target={ZIG_TARGET}\n\
         optimize={ZIG_OPTIMIZE}\n\
         vt_features={VT_FEATURES}\n\
         module_sha256={module_sha256}\n",
        SOURCE_TARBALL.sha256, DEPS_TARBALL.sha256,
    )
}

/// Whether the installed module is current: the stamp exists and is exactly
/// the one this build would write for the installed module's hash — so a
/// changed pin, feature set, or Zig, a module replaced or edited since, or
/// a missing module or stamp all mean it isn't.
fn module_is_current(
    stamp: Option<&str>,
    zig_version: &str,
    installed_module_sha256: Option<&str>,
) -> bool {
    match (stamp, installed_module_sha256) {
        (Some(stamp), Some(module_sha256)) => stamp == stamp_text(zig_version, module_sha256),
        _ => false,
    }
}

/// The installed module's hash when it is current (see
/// [`module_is_current`]), else `None`.
fn current_module_hash(
    stamp_path: &Path,
    module_path: &Path,
    zig_version: &str,
) -> Result<Option<String>> {
    let stamp = match fs::read_to_string(stamp_path) {
        Ok(stamp) => stamp,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("can't read {}: {e}", stamp_path.display()).into()),
    };
    if !module_path.is_file() {
        return Ok(None);
    }
    let module_sha256 = sha256_of_file(module_path)?;
    Ok(module_is_current(Some(&stamp), zig_version, Some(&module_sha256)).then_some(module_sha256))
}

/// The pinned file in `dir`, downloaded unless a copy with the pinned hash
/// is already there. A copy or download with any other hash is deleted, and
/// a download that doesn't match is refused.
fn fetch_verified(dir: &Path, file: PinnedFile) -> Result<PathBuf> {
    let path = dir.join(file.name);
    if path.is_file() {
        let actual = sha256_of_file(&path)?;
        if actual == file.sha256 {
            println!("[xtask] using the cached {} (sha256 verified)", file.name);
            return Ok(path);
        }
        println!(
            "[xtask] the cached {} doesn't match its pinned sha256 — downloading it again",
            file.name
        );
        fs::remove_file(&path)?;
    }

    let url = format!("{RELEASE_URL}{}", file.name);
    let partial = dir.join(format!("{}.partial", file.name));
    remove_file_if_present(&partial)?;
    println!("[xtask] downloading {url}");
    let status = Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--retry",
            "2",
            // a server that never answers, or stalls mid-download, fails the
            // step instead of hanging it
            "--connect-timeout",
            "30",
            "--speed-limit",
            "1024",
            "--speed-time",
            "60",
            "--output",
        ])
        .arg(&partial)
        .arg(&url)
        .stdin(Stdio::null())
        .status()?;
    if !status.success() {
        remove_file_if_present(&partial)?;
        return Err(format!("downloading {url} failed ({status})").into());
    }
    let actual = sha256_of_file(&partial)?;
    if actual != file.sha256 {
        remove_file_if_present(&partial)?;
        return Err(format!(
            "{} doesn't match its pinned sha256, so it was deleted and nothing was unpacked or \
             built:\n  expected {}\n  actual   {actual}\n  from     {url}",
            file.name, file.sha256
        )
        .into());
    }
    fs::rename(&partial, &path)?;
    println!("[xtask] downloaded {} (sha256 verified)", file.name);
    Ok(path)
}

/// Unpack both tarballs into a fresh `build_dir` and build the module
/// offline, returning the built module's path.
fn build_module(build_dir: &Path, source_tarball: &Path, deps_tarball: &Path) -> Result<PathBuf> {
    remove_dir_if_present(build_dir)?;
    fs::create_dir_all(build_dir)?;
    for tarball in [source_tarball, deps_tarball] {
        println!(
            "[xtask] unpacking {}",
            tarball.file_name().map_or_else(
                || tarball.display().to_string(),
                |name| name.to_string_lossy().into_owned()
            )
        );
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(tarball)
            .arg("-C")
            .arg(build_dir)
            .arg("--no-same-owner")
            .stdin(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(format!("unpacking {} failed ({status})", tarball.display()).into());
        }
    }
    let source_dir = build_dir.join(SOURCE_DIR_NAME);
    let deps_dir = build_dir.join(DEPS_DIR_NAME);
    for dir in [&source_dir, &deps_dir] {
        if !dir.is_dir() {
            return Err(format!("the tarballs didn't unpack to {}", dir.display()).into());
        }
    }
    // new and empty, as the packaging guide requires of the global cache
    let global_cache = build_dir.join("zig-global-cache");
    let local_cache = build_dir.join("zig-local-cache");
    let out_dir = build_dir.join("out");
    for dir in [&global_cache, &local_cache] {
        fs::create_dir(dir)?;
    }

    println!(
        "[xtask] building libghostty-vt {VERSION} for {ZIG_TARGET} ({ZIG_OPTIMIZE}, \
         -Dvt-features={VT_FEATURES}), offline..."
    );
    let status = Command::new("zig")
        .args(zig_build_args(&deps_dir, &out_dir))
        .current_dir(&source_dir)
        .env("ZIG_GLOBAL_CACHE_DIR", &global_cache)
        .env("ZIG_LOCAL_CACHE_DIR", &local_cache)
        // an exported `DESTDIR` would install under it instead of `out_dir`
        .env_remove("DESTDIR")
        .stdin(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("zig build failed ({status})").into());
    }
    let built = out_dir.join("bin").join("ghostty-vt.wasm");
    if !built.is_file() {
        return Err(format!("zig build succeeded but wrote no {}", built.display()).into());
    }
    Ok(built)
}

/// The `zig build` arguments: offline against `deps_dir`, installing under
/// `out_dir`.
fn zig_build_args(deps_dir: &Path, out_dir: &Path) -> Vec<OsString> {
    vec![
        OsString::from("build"),
        OsString::from("--system"),
        deps_dir.as_os_str().to_owned(),
        OsString::from(format!("-Dtarget={ZIG_TARGET}")),
        OsString::from(format!("-Doptimize={ZIG_OPTIMIZE}")),
        OsString::from(format!("-Dvt-features={VT_FEATURES}")),
        OsString::from("--prefix"),
        out_dir.as_os_str().to_owned(),
    ]
}

/// A file's sha256 as lowercase hex, from `sha256sum` reading it on stdin
/// (so no file name is ever printed back or escaped).
fn sha256_of_file(path: &Path) -> Result<String> {
    let file = fs::File::open(path).map_err(|e| format!("can't open {}: {e}", path.display()))?;
    let output = Command::new("sha256sum").stdin(file).output()?;
    if !output.status.success() {
        return Err(format!("sha256sum of {} failed ({})", path.display(), output.status).into());
    }
    parse_sha256sum(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("sha256sum printed no hash for {}", path.display()).into())
}

/// The hash in `sha256sum`'s output (`<64 hex>  -` for stdin), or `None`
/// when it isn't there.
fn parse_sha256sum(output: &str) -> Option<String> {
    let hash = output.split_whitespace().next()?;
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hash.to_ascii_lowercase())
}

/// Write `contents` to `path` all at once: into a temporary file beside it,
/// synced, then renamed over it — so a reader never sees a partial file, and
/// a failure leaves the old one in place.
fn write_atomically(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("{} has no file name", path.display()))?
        .to_string_lossy();
    let temp = parent.join(temp_file_name(&file_name, std::process::id()));
    let written = fs::File::create(&temp).and_then(|mut file| {
        file.write_all(contents)?;
        file.sync_all()
    });
    if let Err(e) = written.and_then(|()| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(format!("can't write {}: {e}", path.display()).into());
    }
    Ok(())
}

/// The name [`write_atomically`] stages `file_name` under in the same
/// directory: hidden, with the writing process's id.
fn temp_file_name(file_name: &str, pid: u32) -> String {
    format!(".{file_name}.{pid}.tmp")
}

/// Whether `candidate` is a [`temp_file_name`] of `file_name`, for any pid.
fn is_temp_file_name(file_name: &str, candidate: &str) -> bool {
    candidate
        .strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(file_name))
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
}

/// Remove the temporary files an interrupted install left beside the module:
/// only regular files named by [`is_temp_file_name`], only in the module's
/// directory. A missing or unreadable directory has none to remove; a file
/// that can't be removed is an error naming it, so it can't ship unnoticed.
fn remove_stale_install_temps(module_path: &Path) -> Result<()> {
    let (Some(dir), Some(module_name)) = (
        module_path.parent(),
        module_path.file_name().and_then(|name| name.to_str()),
    ) else {
        return Ok(());
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    let mut failures = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let is_stale = name
            .to_str()
            .is_some_and(|name| is_temp_file_name(module_name, name))
            // `file_type` doesn't follow symlinks, so a link is left alone
            && entry.file_type().is_ok_and(|kind| kind.is_file());
        if !is_stale {
            continue;
        }
        let path = entry.path();
        match fs::remove_file(&path) {
            Ok(()) => println!(
                "[xtask] removed {}, left by an interrupted install",
                path.display()
            ),
            Err(e) => failures.push(format!("{}: {e}", path.display())),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "can't remove the temporary file(s) an interrupted install left, which a build \
             would ship: {}",
            failures.join("; ")
        )
        .into())
    }
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            Err(format!("can't remove {}: {e}", path.display()).into())
        }
        _ => Ok(()),
    }
}

fn remove_dir_if_present(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            Err(format!("can't remove {}: {e}", path.display()).into())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn zig_version_must_be_a_release_of_the_pinned_minor() {
        for accepted in ["0.17.0", "0.17.1", "0.17.12"] {
            assert_eq!(check_zig_version(accepted), Ok(()), "{accepted}");
        }
        for refused in [
            "",
            "0.17",
            "0.17.",
            "0.16.0",
            "0.18.0",
            "1.17.0",
            "0.170.0",
            "0.17.0-dev.1234+abcdef",
            "0.17.1-dev.5+0123456",
            "0.17.0 ",
            "v0.17.0",
            "0.17.x",
        ] {
            let err = check_zig_version(refused).unwrap_err();
            assert!(err.contains(&format!("is `{refused}`")), "{err}");
            assert!(err.contains("Zig 0.17.x"), "{err}");
        }
    }

    #[test]
    fn the_module_is_current_only_for_its_own_stamp() {
        let stamp = stamp_text("0.17.0", HASH_A);
        assert!(module_is_current(Some(&stamp), "0.17.0", Some(HASH_A)));
        // the module was replaced or edited since the stamp was written
        assert!(!module_is_current(Some(&stamp), "0.17.0", Some(HASH_B)));
        // another Zig would build another module
        assert!(!module_is_current(Some(&stamp), "0.17.1", Some(HASH_A)));
        // no stamp, no module
        assert!(!module_is_current(None, "0.17.0", Some(HASH_A)));
        assert!(!module_is_current(Some(&stamp), "0.17.0", None));
        assert!(!module_is_current(None, "0.17.0", None));
        // a stamp from other pins or features (any changed line) is stale
        for (from, to) in [
            (VERSION, "0.9.9"),
            (SOURCE_TARBALL.sha256, HASH_B),
            (DEPS_TARBALL.sha256, HASH_B),
            (VT_FEATURES, "-all,+render-state"),
            (ZIG_OPTIMIZE, "ReleaseFast"),
            (ZIG_TARGET, "wasm32-wasi"),
        ] {
            let stale = stamp.replace(from, to);
            assert_ne!(stale, stamp, "{from}");
            assert!(
                !module_is_current(Some(&stale), "0.17.0", Some(HASH_A)),
                "{from}"
            );
        }
        assert!(!module_is_current(Some(""), "0.17.0", Some(HASH_A)));
        assert!(!module_is_current(
            Some(stamp.trim_end()),
            "0.17.0",
            Some(HASH_A)
        ));
    }

    #[test]
    fn the_stamp_records_every_input_and_the_output() {
        let stamp = stamp_text("0.17.0", HASH_A);
        for line in [
            format!("libghostty_vt_version={VERSION}"),
            format!("source_sha256={}", SOURCE_TARBALL.sha256),
            format!("deps_sha256={}", DEPS_TARBALL.sha256),
            "zig_version=0.17.0".to_owned(),
            format!("target={ZIG_TARGET}"),
            format!("optimize={ZIG_OPTIMIZE}"),
            format!("vt_features={VT_FEATURES}"),
            format!("module_sha256={HASH_A}"),
        ] {
            assert!(stamp.lines().any(|l| l == line), "{line} in\n{stamp}");
        }
    }

    #[test]
    fn the_pins_name_one_release() {
        assert_eq!(VERSION, "1.0.0");
        assert_eq!(
            RELEASE_URL,
            "https://release.files.ghostty.org/libghostty-vt/1.0.0/"
        );
        assert_eq!(SOURCE_TARBALL.name, "libghostty-vt-1.0.0.tar.gz");
        assert_eq!(DEPS_TARBALL.name, "libghostty-vt-1.0.0-deps.tar.gz");
        assert_eq!(SOURCE_DIR_NAME, "libghostty-vt-1.0.0");
        assert_eq!(DEPS_DIR_NAME, "libghostty-vt-1.0.0-deps");
        for file in [SOURCE_TARBALL, DEPS_TARBALL] {
            assert_eq!(
                parse_sha256sum(file.sha256).as_deref(),
                Some(file.sha256),
                "{} is a lowercase sha256",
                file.name
            );
        }
        assert_ne!(SOURCE_TARBALL.sha256, DEPS_TARBALL.sha256);
    }

    #[test]
    fn sha256sum_output_is_parsed_strictly() {
        assert_eq!(
            parse_sha256sum(&format!("{HASH_A}  -\n")).as_deref(),
            Some(HASH_A)
        );
        assert_eq!(
            parse_sha256sum(&format!("{}  -\n", HASH_A.to_uppercase())).as_deref(),
            Some(HASH_A)
        );
        for bad in [
            "",
            "\n",
            "abc  -",
            &format!("{HASH_A}a  -"),
            &format!("{}g  -", &HASH_A[1..]),
        ] {
            assert_eq!(parse_sha256sum(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn zig_builds_offline_with_the_pinned_options() {
        let args = zig_build_args(Path::new("/c/deps dir"), Path::new("/c/out"));
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(
            args,
            [
                "build",
                "--system",
                "/c/deps dir",
                "-Dtarget=wasm32-freestanding",
                "-Doptimize=ReleaseSmall",
                "-Dvt-features=-all,+render-state,+input-encode,+selection,+formatter",
                "--prefix",
                "/c/out",
            ]
        );
    }

    #[test]
    fn install_temp_files_are_recognized_by_name_alone() {
        let module = "ghostty-vt.wasm";
        assert_eq!(temp_file_name(module, 4242), ".ghostty-vt.wasm.4242.tmp");
        assert!(is_temp_file_name(module, &temp_file_name(module, 1)));
        assert!(is_temp_file_name(module, &temp_file_name(module, u32::MAX)));
        for other in [
            "ghostty-vt.wasm",
            ".ghostty-vt.wasm.tmp",
            ".ghostty-vt.wasm..tmp",
            ".ghostty-vt.wasm.12a.tmp",
            ".ghostty-vt.wasm.-1.tmp",
            ".ghostty-vt.wasm.12.tmp.bak",
            "ghostty-vt.wasm.12.tmp",
            ".other.wasm.12.tmp",
            ".ghostty-vt.wasm.12.temp",
            ".ghostty-vt.wasmx.12.tmp",
            ".stamp.12.tmp",
        ] {
            assert!(!is_temp_file_name(module, other), "{other}");
        }
    }

    #[test]
    fn the_installed_module_is_gitignored() {
        let gitignore = fs::read_to_string(crate::workspace_root().join(".gitignore")).unwrap();
        assert!(
            gitignore
                .lines()
                .any(|line| line == format!("/{MODULE_PATH}")),
            "/{MODULE_PATH} in .gitignore"
        );
        // the install's temporary file (see `write_atomically`), should one be left
        let temp_pattern = format!(
            "/{}/.*.tmp",
            Path::new(MODULE_PATH).parent().unwrap().display()
        );
        assert!(
            gitignore.lines().any(|line| line == temp_pattern),
            "{temp_pattern} in .gitignore"
        );
        assert!(Path::new(CACHE_DIR).starts_with("target"), "under target/");
    }
}
