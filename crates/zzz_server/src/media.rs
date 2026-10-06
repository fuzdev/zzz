//! Media files: which containers zzz handles, and the `ffmpeg` runs over them.
//!
//! `ffmpeg` is a large parser handed files that may come from anywhere (a
//! cloned repo, a download), and a file that looks like audio can be a
//! playlist or a concat script telling it to open other files or fetch URLs.
//! So it is never given a path. Every run here:
//!
//! - reads the input from, and writes the output to, **file handles zzz
//!   opened** (the `fd:` protocol on the child's stdin and stdout) — the
//!   input handle is the one `ScopedFs` validated, so there is no second path
//!   lookup to race;
//! - allows **only** the `fd` protocol (`-protocol_whitelist fd`), so nothing
//!   in the file can make it open another file or a network address;
//! - **names the input's format** (`-f`), chosen from the file's extension
//!   ([`MediaContainer`]), so the bytes are never probed for what they claim
//!   to be.
//!
//! Runs go through [`crate::tool::run_tool`] (scrubbed environment, a timeout,
//! a bounded stderr tail).

use std::ffi::OsString;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;
use std::time::Duration;

use crate::scoped_fs::TEMP_FILE_PREFIX;
use crate::tool::{ToolError, ToolRun, run_tool};

/// How long a remux may run. It copies streams without re-encoding, so even
/// a long recording takes seconds.
pub const REMUX_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How long a decode to PCM may run — far faster than real time, so this
/// allows for many hours of audio on a slow disk.
pub const DECODE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Sample rate of the PCM a speech recognizer is fed.
pub const SPEECH_SAMPLE_RATE: u32 = 16_000;

/// Size of the header `ffmpeg` writes on a PCM WAV file.
const WAV_HEADER_BYTES: u64 = 44;

/// A media container zzz hands to `ffmpeg`, known from a file's extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaContainer {
    Webm,
    Matroska,
    Ogg,
    Mp4,
    Mp3,
    Wav,
    Flac,
    Aac,
}

impl MediaContainer {
    /// The container a path's extension names, case-insensitively — `None`
    /// for anything else.
    #[must_use]
    pub fn from_path(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next()?;
        let (_, extension) = name.rsplit_once('.')?;
        match extension.to_ascii_lowercase().as_str() {
            "webm" | "weba" => Some(Self::Webm),
            "mkv" | "mka" => Some(Self::Matroska),
            "ogg" | "oga" | "opus" => Some(Self::Ogg),
            "mp4" | "m4a" => Some(Self::Mp4),
            "mp3" => Some(Self::Mp3),
            "wav" => Some(Self::Wav),
            "flac" => Some(Self::Flac),
            "aac" => Some(Self::Aac),
            _ => None,
        }
    }

    /// The `ffmpeg` demuxer that reads it.
    #[must_use]
    pub const fn demuxer(self) -> &'static str {
        match self {
            Self::Webm | Self::Matroska => "matroska",
            Self::Ogg => "ogg",
            Self::Mp4 => "mov",
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Aac => "aac",
        }
    }

    /// The `ffmpeg` muxer that writes it.
    #[must_use]
    pub const fn muxer(self) -> &'static str {
        match self {
            Self::Webm => "webm",
            Self::Matroska => "matroska",
            Self::Ogg => "ogg",
            Self::Mp4 => "mp4",
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Aac => "adts",
        }
    }
}

/// The options every `ffmpeg` run starts with, up to and including its input:
/// quiet, no interaction, the `fd` protocol only, and the input read as
/// `container` from standard input.
fn input_args(container: MediaContainer) -> Vec<OsString> {
    [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "fd",
        "-f",
        container.demuxer(),
        "-fd",
        "0",
        "-i",
        "fd:",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// Arguments for a remux: copy the audio and video streams of the input (on
/// stdin) into a fresh `container` file (on stdout), without re-encoding.
#[must_use]
pub fn remux_args(container: MediaContainer) -> Vec<OsString> {
    let mut args = input_args(container);
    args.extend(
        [
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-f",
            container.muxer(),
            "-fd",
            "1",
            "fd:",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args
}

/// Rewrite `input` into `output` as a well-formed `container` file.
///
/// A browser's `MediaRecorder` streams its file out, so it can't go back and
/// store the duration or a seek index in the header: players show an unknown
/// length and seek poorly. A stream copy through `ffmpeg` into a seekable
/// file writes both. `output` must be an empty regular file open for writing.
///
/// # Errors
///
/// As [`run_tool`] — [`ToolError::Failed`] when `ffmpeg` can't read `input`
/// as `container`.
pub async fn remux(
    ffmpeg: &Path,
    container: MediaContainer,
    input: std::fs::File,
    output: std::fs::File,
) -> Result<(), ToolError> {
    run_tool(ToolRun {
        program: ffmpeg,
        args: remux_args(container),
        stdin: Some(input),
        stdout: Some(output),
        timeout: REMUX_TIMEOUT,
    })
    .await
}

/// Arguments for a decode to speech PCM: the first audio stream of the input
/// (on stdin) as a mono 16-bit WAV at [`SPEECH_SAMPLE_RATE`] (on stdout).
#[must_use]
pub fn decode_speech_args(container: MediaContainer) -> Vec<OsString> {
    let mut args = input_args(container);
    let sample_rate = SPEECH_SAMPLE_RATE.to_string();
    args.extend(
        [
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            sample_rate.as_str(),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-fd",
            "1",
            "fd:",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args
}

/// Decode `input`'s audio into `output` as the WAV a speech recognizer reads:
/// mono, 16-bit, [`SPEECH_SAMPLE_RATE`]. `output` must be an empty regular
/// file open for writing.
///
/// # Errors
///
/// As [`run_tool`] — [`ToolError::Failed`] when `ffmpeg` can't read `input`
/// as `container`, or it has no audio.
pub async fn decode_speech(
    ffmpeg: &Path,
    container: MediaContainer,
    input: std::fs::File,
    output: std::fs::File,
) -> Result<(), ToolError> {
    run_tool(ToolRun {
        program: ffmpeg,
        args: decode_speech_args(container),
        stdin: Some(input),
        stdout: Some(output),
        timeout: DECODE_TIMEOUT,
    })
    .await
}

/// The duration, in milliseconds, of a WAV [`decode_speech`] wrote that is
/// `wav_bytes` long.
#[must_use]
pub const fn speech_wav_duration_ms(wav_bytes: u64) -> u64 {
    // mono 16-bit: two bytes a sample
    let bytes_per_ms = SPEECH_SAMPLE_RATE as u64 * 2 / 1000;
    wav_bytes.saturating_sub(WAV_HEADER_BYTES) / bytes_per_ms
}

/// A tool's command line as text, for display: the program's file name and
/// its arguments, space-separated. Not for running — nothing is quoted.
#[must_use]
pub fn display_command(program: &Path, args: &[OsString]) -> String {
    let mut command = program
        .file_name()
        .unwrap_or(program.as_os_str())
        .to_string_lossy()
        .into_owned();
    for arg in args {
        command.push(' ');
        command.push_str(&arg.to_string_lossy());
    }
    command
}

/// Create a temp file in `dir` that has no name.
///
/// Created exclusively under a staging name ([`TEMP_FILE_PREFIX`], so the
/// filer never indexes it), mode `0600`, opened for reading and writing, and
/// unlinked before returning. It lives exactly as long as its handles, so
/// nothing is left behind by a crash or a killed tool.
///
/// # Errors
///
/// The I/O error from creating `dir` or the file.
pub fn create_unnamed_temp_file(dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!(
        "{TEMP_FILE_PREFIX}{}",
        uuid::Uuid::new_v4().simple()
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(&path)?;
    std::fs::remove_file(&path)?;
    Ok(file)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
pub(crate) mod tests {
    use std::io::{Read as _, Seek as _, Write as _};
    use std::path::PathBuf;

    use super::*;
    use crate::tool::{Tools, is_executable_file};

    /// The `ffmpeg` on this machine, or `None` after printing a visible skip.
    pub fn ffmpeg_or_skip(test: &str) -> Option<PathBuf> {
        let ffmpeg = Tools::from_env().ok().and_then(|tools| tools.ffmpeg);
        if ffmpeg.is_none() {
            eprintln!("SKIPPED {test}: no ffmpeg on PATH");
        }
        ffmpeg
    }

    /// One second of Opus in a `.webm`, muxed to a pipe the way `MediaRecorder`
    /// streams its output: no duration and no seek index.
    pub fn streamed_webm(ffmpeg: &Path) -> Vec<u8> {
        let output = std::process::Command::new(ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:a",
                "libopus",
                "-f",
                "webm",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(!output.stdout.is_empty());
        output.stdout
    }

    /// The `ffprobe` beside `ffmpeg`, if there is one.
    pub fn ffprobe_beside(ffmpeg: &Path) -> Option<PathBuf> {
        let ffprobe = ffmpeg.with_file_name("ffprobe");
        is_executable_file(&ffprobe).then_some(ffprobe)
    }

    /// The duration in a file's header, in seconds — `None` when it has none.
    pub fn header_duration(ffprobe: &Path, file: &Path) -> Option<f64> {
        let output = std::process::Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(file)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().parse().ok()
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("zzz-media-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn containers_come_from_the_extension_alone() {
        assert_eq!(
            MediaContainer::from_path("/a/voice.webm"),
            Some(MediaContainer::Webm)
        );
        assert_eq!(
            MediaContainer::from_path("/a/VOICE.OGG"),
            Some(MediaContainer::Ogg)
        );
        assert_eq!(
            MediaContainer::from_path("/a/b.c/clip.m4a"),
            Some(MediaContainer::Mp4)
        );
        assert_eq!(
            MediaContainer::from_path("/a/song.mp3"),
            Some(MediaContainer::Mp3)
        );
        for path in [
            "/a/list.m3u8",
            "/a/script.ffconcat",
            "/a/notes.txt",
            "/a/webm",
            "/a/.webm/x",
            "/a/clip.avi",
        ] {
            assert_eq!(MediaContainer::from_path(path), None, "{path}");
        }
    }

    #[test]
    fn every_run_is_confined_to_its_handles() {
        let args = remux_args(MediaContainer::Webm);
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        let position = |flag: &str| args.iter().position(|arg| *arg == flag).unwrap();
        let input = position("-i");
        // only the `fd` protocol, and a named format, both before the input
        // they apply to
        assert_eq!(args[position("-protocol_whitelist") + 1], "fd");
        assert!(position("-protocol_whitelist") < input);
        assert_eq!(args[position("-f") + 1], "matroska");
        assert!(position("-f") < input);
        // the input and the output are both `fd:` — no argument is a path
        assert_eq!(args[input + 1], "fd:");
        assert_eq!(args.last(), Some(&"fd:"));
        assert!(args.iter().all(|arg| !arg.contains('/')), "{args:?}");
        assert!(args.contains(&"-nostdin"));
    }

    #[test]
    fn an_unnamed_temp_file_leaves_nothing_in_its_directory() {
        let tmp = TempDir::new();
        let dir = tmp.0.join("cache");
        let mut file = create_unnamed_temp_file(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        file.write_all(b"scratch").unwrap();
        file.rewind().unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        assert_eq!(content, "scratch");
    }

    #[tokio::test]
    async fn a_remux_gives_a_streamed_recording_its_duration() {
        let Some(ffmpeg) = ffmpeg_or_skip("a_remux_gives_a_streamed_recording_its_duration") else {
            return;
        };
        let tmp = TempDir::new();
        let source = tmp.0.join("live.webm");
        std::fs::write(&source, streamed_webm(&ffmpeg)).unwrap();
        let remuxed = tmp.0.join("final.webm");

        remux(
            &ffmpeg,
            MediaContainer::Webm,
            std::fs::File::open(&source).unwrap(),
            std::fs::File::create(&remuxed).unwrap(),
        )
        .await
        .unwrap();

        assert!(std::fs::metadata(&remuxed).unwrap().len() > 0);
        let Some(ffprobe) = ffprobe_beside(&ffmpeg) else {
            eprintln!("SKIPPED the duration check: no ffprobe beside ffmpeg");
            return;
        };
        assert_eq!(
            header_duration(&ffprobe, &source),
            None,
            "the streamed file has no duration"
        );
        let duration = header_duration(&ffprobe, &remuxed).expect("the remuxed file has one");
        assert!((0.9..1.2).contains(&duration), "{duration}");
    }

    #[tokio::test]
    async fn every_container_remuxes_through_handles() {
        let Some(ffmpeg) = ffmpeg_or_skip("every_container_remuxes_through_handles") else {
            return;
        };
        let tmp = TempDir::new();
        // streamed the way a recorder writes each: Ogg pages, fragmented MP4
        for (name, encode) in [
            ("clip.ogg", &["-c:a", "libopus", "-f", "ogg"][..]),
            (
                "clip.m4a",
                &[
                    "-c:a",
                    "aac",
                    "-f",
                    "mp4",
                    "-movflags",
                    "frag_keyframe+empty_moov",
                ][..],
            ),
        ] {
            let streamed = std::process::Command::new(&ffmpeg)
                .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
                .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=1"])
                .args(encode)
                .arg("pipe:1")
                .output()
                .unwrap();
            assert!(streamed.status.success(), "{name}: {streamed:?}");
            let source = tmp.0.join(name);
            std::fs::write(&source, &streamed.stdout).unwrap();
            let remuxed = tmp.0.join(format!("final-{name}"));

            let container = MediaContainer::from_path(source.to_str().unwrap()).unwrap();
            remux(
                &ffmpeg,
                container,
                std::fs::File::open(&source).unwrap(),
                std::fs::File::create(&remuxed).unwrap(),
            )
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert!(std::fs::metadata(&remuxed).unwrap().len() > 0, "{name}");
            if let Some(ffprobe) = ffprobe_beside(&ffmpeg) {
                let duration = header_duration(&ffprobe, &remuxed).expect(name);
                assert!((0.9..1.2).contains(&duration), "{name}: {duration}");
            }
        }
    }

    #[test]
    fn a_speech_wav_is_timed_by_its_size() {
        assert_eq!(speech_wav_duration_ms(0), 0);
        assert_eq!(speech_wav_duration_ms(44), 0);
        // one second is 16000 samples of two bytes
        assert_eq!(speech_wav_duration_ms(44 + 32_000), 1000);
        assert_eq!(speech_wav_duration_ms(44 + 16_000), 500);
    }

    #[test]
    fn a_decode_is_confined_like_a_remux() {
        let args = decode_speech_args(MediaContainer::Mp3);
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        let position = |flag: &str| args.iter().position(|arg| *arg == flag).unwrap();
        assert_eq!(args[position("-protocol_whitelist") + 1], "fd");
        assert_eq!(args[position("-f") + 1], "mp3");
        assert_eq!(args[position("-i") + 1], "fd:");
        assert_eq!(args.last(), Some(&"fd:"));
        assert!(args.iter().all(|arg| !arg.contains('/')), "{args:?}");
        assert_eq!(args[position("-ar") + 1], "16000");
        assert_eq!(args[position("-ac") + 1], "1");
    }

    #[test]
    fn a_command_displays_as_its_name_and_arguments() {
        assert_eq!(
            display_command(
                Path::new("/usr/bin/ffmpeg"),
                &["-i".into(), "fd:".into(), "-f".into(), "wav".into()]
            ),
            "ffmpeg -i fd: -f wav"
        );
    }

    #[tokio::test]
    async fn a_decode_writes_speech_pcm() {
        let Some(ffmpeg) = ffmpeg_or_skip("a_decode_writes_speech_pcm") else {
            return;
        };
        let tmp = TempDir::new();
        let source = tmp.0.join("live.webm");
        std::fs::write(&source, streamed_webm(&ffmpeg)).unwrap();
        let wav = tmp.0.join("speech.wav");
        decode_speech(
            &ffmpeg,
            MediaContainer::Webm,
            std::fs::File::open(&source).unwrap(),
            std::fs::File::create(&wav).unwrap(),
        )
        .await
        .unwrap();
        let bytes = std::fs::read(&wav).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // the one-second tone, give or take the codec's padding
        let duration = speech_wav_duration_ms(bytes.len() as u64);
        assert!((950..1100).contains(&duration), "{duration}");
    }

    #[tokio::test]
    async fn a_script_dressed_as_media_can_not_reach_another_file() {
        let Some(ffmpeg) = ffmpeg_or_skip("a_script_dressed_as_media_can_not_reach_another_file")
        else {
            return;
        };
        let tmp = TempDir::new();
        std::fs::write(tmp.0.join("real.webm"), streamed_webm(&ffmpeg)).unwrap();
        // a concat script: unrestricted, ffmpeg would open `real.webm` for it
        let script = tmp.0.join("evil.webm");
        std::fs::write(&script, "ffconcat version 1.0\nfile 'real.webm'\n").unwrap();
        let output = tmp.0.join("out.webm");

        let result = remux(
            &ffmpeg,
            MediaContainer::Webm,
            std::fs::File::open(&script).unwrap(),
            std::fs::File::create(&output).unwrap(),
        )
        .await;
        assert!(
            matches!(result, Err(ToolError::Failed { .. })),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn a_file_that_is_not_media_fails_with_ffmpegs_reason() {
        let Some(ffmpeg) = ffmpeg_or_skip("a_file_that_is_not_media_fails_with_ffmpegs_reason")
        else {
            return;
        };
        let tmp = TempDir::new();
        let source = tmp.0.join("text.webm");
        std::fs::write(&source, "just some text\n").unwrap();
        let result = remux(
            &ffmpeg,
            MediaContainer::Webm,
            std::fs::File::open(&source).unwrap(),
            std::fs::File::create(tmp.0.join("out.webm")).unwrap(),
        )
        .await;
        let Err(ToolError::Failed { stderr, .. }) = result else {
            panic!("{result:?}");
        };
        assert!(!stderr.is_empty());
    }
}
