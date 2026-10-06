//! Transcription: speech in an audio file to timed text, by a local model.
//!
//! Audio is only ever processed on this machine — nothing here speaks to a
//! network. The recognizer is an enum-dispatched seam
//! ([`TranscriptionBackend`]) with one variant, whisper.cpp
//! ([`whisper_cpp`]); a backend's contract is **timed segments**, with timing
//! optional per segment so one that returns only text still fits.
//!
//! A transcription is a job ([`crate::job_manager`]): it takes minutes, so it
//! outlives the request that started it. [`run_transcription`] is the work:
//!
//! 1. open the source through `ScopedFs`, and hash it (`blake3`);
//! 2. decode it with `ffmpeg` to the mono 16 kHz PCM a recognizer reads
//!    ([`crate::media::decode_speech`] — confined to file handles), into an
//!    unnamed scratch file;
//! 3. run the backend over that PCM, reporting progress and each segment as
//!    it's decoded (`transcription_progress`, to the owner's sockets);
//! 4. write the result as a **sidecar** beside the source,
//!    `<source name>.<model>.transcript.json` ([`Transcript`]) — created
//!    exclusively, so a transcript is written once and never replaced.
//!
//! The sidecar is tool output: it records what it was made from (the
//! source's hash and size) and what made it (backend, version, model and its
//! hash, parameters), so a source whose bytes changed no longer matches.

pub mod whisper_cpp;

use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use crate::job_manager::{JobFailure, JobHandle};
use crate::media::{
    MediaContainer, create_unnamed_temp_file, decode_speech, decode_speech_args, display_command,
    speech_wav_duration_ms,
};
use crate::scoped_fs::TEMP_FILE_PREFIX;
use crate::tool::{ToolError, ToolLine, ToolRun, Tools, run_tool_lines};
use whisper_cpp::WhisperCpp;

/// The transcript format this writes.
pub const TRANSCRIPT_VERSION: u32 = 1;

/// What every transcript sidecar's name ends with.
pub const TRANSCRIPT_SIDECAR_SUFFIX: &str = ".transcript.json";

/// Subdirectory of the app directory that scratch files are created in.
const CACHE_DIR: &str = "cache";

/// A transcript sidecar: timed text, what it was made from, and what made it.
/// Twin of the TS `Transcript`.
#[derive(Debug, Clone, Serialize)]
pub struct Transcript {
    pub version: u32,
    pub source: TranscriptSource,
    pub tool: TranscriptTool,
    /// The language spoken, as the backend detected or was told — `None`
    /// when it didn't say.
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
}

/// The audio a transcript was made from, as it was then.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptSource {
    /// The source's file name — it sits beside the sidecar.
    pub name: String,
    /// `blake3:<hex>` of the source's bytes.
    pub blake3: String,
    pub size: u64,
    pub duration_ms: u64,
}

/// What made a transcript.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptTool {
    pub backend: &'static str,
    /// The backend's version, when it reports one.
    pub version: Option<String>,
    /// The model's short name (see [`whisper_cpp::model_slug`]).
    pub model: String,
    /// `blake3:<hex>` of the model file.
    pub model_blake3: String,
    pub params: TranscriptParams,
}

/// The parameters a transcription ran with.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptParams {
    /// The language asked for: a code, or `auto` to detect.
    pub language: String,
}

/// A stretch of speech. Times are `None` from a backend that doesn't time
/// its text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptSegment {
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<TranscriptWord>,
}

/// One word of a segment, with the backend's confidence in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    /// `0.0..=1.0`.
    pub p: f32,
}

/// The sidecar path for a transcript of `source_path` by the model
/// `model_slug`: `<source path>.<model slug>.transcript.json`. The slug is in
/// the name so one source can hold a transcript per model.
#[must_use]
pub fn transcript_sidecar_path(source_path: &str, model_slug: &str) -> String {
    format!("{source_path}.{model_slug}{TRANSCRIPT_SIDECAR_SUFFIX}")
}

/// Whether `language` is one a transcription accepts: `auto`, or a two- or
/// three-letter lowercase code.
#[must_use]
pub fn is_transcription_language(language: &str) -> bool {
    language == "auto"
        || ((2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase()))
}

/// A local speech recognizer. Enum-dispatched, like the AI providers: the
/// variants are known at compile time.
#[derive(Debug, Clone)]
pub enum TranscriptionBackend {
    WhisperCpp(WhisperCpp),
}

impl TranscriptionBackend {
    /// The backend the configured tools make available.
    ///
    /// # Errors
    ///
    /// [`ToolError::Unavailable`] when the recognizer or its model wasn't
    /// found at boot.
    pub fn from_tools(tools: &Tools) -> Result<Self, ToolError> {
        let (bin, model) = tools.whisper_cpp()?;
        Ok(Self::WhisperCpp(WhisperCpp {
            bin: bin.to_owned(),
            model: model.to_owned(),
        }))
    }

    /// The backend's name in a transcript's `tool.backend`.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::WhisperCpp(_) => "whisper_cpp",
        }
    }

    /// The short name of the model it loads, for the sidecar's file name.
    #[must_use]
    pub fn model_slug(&self) -> String {
        match self {
            Self::WhisperCpp(whisper) => whisper_cpp::model_slug(&whisper.model),
        }
    }

    fn model_path(&self) -> &Path {
        match self {
            Self::WhisperCpp(whisper) => &whisper.model,
        }
    }
}

/// What a transcription job is asked to do.
#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    /// The audio file's absolute path.
    pub path: String,
    pub container: MediaContainer,
    /// A language code, or `auto`.
    pub language: String,
    pub backend: TranscriptionBackend,
    pub ffmpeg: PathBuf,
}

#[derive(Serialize)]
struct TranscriptionProgressParams<'a> {
    job_id: &'a str,
    segments: &'a [TranscriptSegment],
}

/// Run a transcription to its sidecar. See the module doc for the steps.
///
/// # Errors
///
/// A [`JobFailure`] saying which step failed, with the tool's stderr tail
/// when a tool did.
pub async fn run_transcription(
    handle: JobHandle,
    request: TranscriptionRequest,
) -> Result<String, JobFailure> {
    let app = Arc::clone(&handle.app);
    let TranscriptionRequest {
        path,
        container,
        language,
        backend,
        ffmpeg,
    } = request;
    let sidecar_path = transcript_sidecar_path(&path, &backend.model_slug());

    // 1. the source, and what it is
    let (source, source_meta) = app
        .scoped_fs
        .open_file(&path)
        .await
        .map_err(|e| JobFailure::new(format!("failed to open the audio: {e}")))?;
    let source_for_hash = source
        .try_clone()
        .map_err(|e| io_failure("clone the source handle", &e))?;
    let source_blake3 = blocking(move || hash_file(source_for_hash))
        .await
        .map_err(|e| io_failure("hash the audio", &e))?;

    // 2. decode to speech PCM
    let cache_dir = Path::new(&app.zzz_dir).join(CACHE_DIR);
    let scratch_dir = cache_dir.clone();
    let (pcm, pcm_writer) = blocking(move || {
        let pcm = create_unnamed_temp_file(&scratch_dir)?;
        let writer = pcm.try_clone()?;
        Ok((pcm, writer))
    })
    .await
    .map_err(|e| io_failure("create a scratch file", &e))?;
    handle.add_command(display_command(&ffmpeg, &decode_speech_args(container)));
    // the hash read the handle to its end, and a clone shares its position
    let source = rewound(source).map_err(|e| io_failure("rewind the audio", &e))?;
    decode_speech(&ffmpeg, container, source, pcm_writer)
        .await
        .map_err(|e| tool_failure("failed to decode the audio", e))?;
    let pcm_bytes = pcm
        .metadata()
        .map_err(|e| io_failure("stat the decoded audio", &e))?
        .len();
    let duration_ms = speech_wav_duration_ms(pcm_bytes);

    // 3. recognize
    let pcm = rewound(pcm).map_err(|e| io_failure("rewind the decoded audio", &e))?;
    let job_id = handle.job_id.to_string();
    let recognized = match &backend {
        TranscriptionBackend::WhisperCpp(whisper) => {
            transcribe_with_whisper_cpp(whisper, &cache_dir, pcm, &language, &handle, |segments| {
                let notification = fuz_http::notification(
                    "transcription_progress",
                    &TranscriptionProgressParams {
                        job_id: &job_id,
                        segments,
                    },
                );
                app.realtime.send_to_account(handle.owner, &notification);
            })
            .await?
        }
    };

    // 4. the sidecar
    let model_path = backend.model_path().to_owned();
    let model_blake3 = blocking(move || hash_model(&model_path))
        .await
        .map_err(|e| io_failure("hash the model", &e))?;
    let transcript = Transcript {
        version: TRANSCRIPT_VERSION,
        source: TranscriptSource {
            name: file_name(&path).to_owned(),
            blake3: source_blake3,
            size: source_meta.len(),
            duration_ms,
        },
        tool: TranscriptTool {
            backend: backend.name(),
            version: recognized.version,
            model: backend.model_slug(),
            model_blake3,
            params: TranscriptParams { language },
        },
        language: recognized.language,
        segments: recognized.segments,
    };
    let mut json = serde_json::to_string_pretty(&transcript)
        .map_err(|e| JobFailure::new(format!("failed to serialize the transcript: {e}")))?;
    json.push('\n');
    app.scoped_fs
        .create_file(&sidecar_path, json)
        .await
        .map_err(|e| JobFailure::new(format!("failed to write the transcript: {e}")))?;
    Ok(sidecar_path)
}

/// What a backend recognized.
struct Recognized {
    version: Option<String>,
    language: Option<String>,
    segments: Vec<TranscriptSegment>,
}

/// One whisper.cpp run over `pcm` (see [`whisper_cpp`]), in a private scratch
/// directory under `cache_dir` that's removed afterward. `on_segments` gets
/// each segment as it's decoded.
async fn transcribe_with_whisper_cpp(
    whisper: &WhisperCpp,
    cache_dir: &Path,
    pcm: std::fs::File,
    language: &str,
    handle: &JobHandle,
    mut on_segments: impl FnMut(&[TranscriptSegment]),
) -> Result<Recognized, JobFailure> {
    let version = whisper_cpp_version(&whisper.bin).await;

    let scratch =
        ScratchDir::create(cache_dir).map_err(|e| io_failure("create a scratch directory", &e))?;
    let output_base = scratch.path.join(whisper_cpp::WHISPER_CPP_OUTPUT_BASE);
    let args = whisper_cpp::transcribe_args(&whisper.model, language, &output_base);
    handle.add_command(display_command(&whisper.bin, &args));

    run_tool_lines(
        ToolRun {
            program: &whisper.bin,
            args,
            stdin: Some(pcm),
            stdout: None,
            timeout: whisper_cpp::WHISPER_CPP_TIMEOUT,
        },
        |line| match line {
            ToolLine::Stdout(text) => {
                if let Some(segment) = whisper_cpp::parse_segment_line(text)
                    && !segment.text.is_empty()
                {
                    on_segments(std::slice::from_ref(&segment));
                }
            }
            ToolLine::Stderr(text) => {
                if let Some(progress) = whisper_cpp::parse_progress_line(text) {
                    handle.set_progress(progress);
                }
            }
        },
    )
    .await
    .map_err(|e| tool_failure("failed to transcribe", e))?;

    let output_path = output_base.with_extension("json");
    let bytes =
        blocking(move || read_bounded(&output_path, whisper_cpp::WHISPER_CPP_OUTPUT_MAX_BYTES))
            .await
            .map_err(|e| io_failure("read the transcription result", &e))?;
    let output = whisper_cpp::parse_output(&bytes).map_err(JobFailure::new)?;
    Ok(Recognized {
        version,
        language: output.language,
        segments: output.segments,
    })
}

/// The version `whisper-cli --version` reports — `None` when it won't say.
async fn whisper_cpp_version(bin: &Path) -> Option<String> {
    let mut first_line: Option<String> = None;
    let result = run_tool_lines(
        ToolRun {
            program: bin,
            args: vec!["--version".into()],
            stdin: None,
            stdout: None,
            timeout: std::time::Duration::from_secs(10),
        },
        |line| {
            if let ToolLine::Stdout(text) = line
                && first_line.is_none()
            {
                first_line = Some(text.to_owned());
            }
        },
    )
    .await;
    if let Err(e) = result {
        tracing::debug!(error = %e, "whisper.cpp did not report a version");
        return None;
    }
    whisper_cpp::parse_version_line(&first_line?)
}

/// A private directory under the cache dir, removed with everything in it
/// when dropped. Named like a staging file, so the filer never indexes it.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn create(cache_dir: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt as _;

        std::fs::create_dir_all(cache_dir)?;
        let path = cache_dir.join(format!(
            "{TEMP_FILE_PREFIX}{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self { path })
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.path) {
            tracing::warn!(path = %self.path.display(), error = %e, "failed to remove a scratch directory");
        }
    }
}

// -- Helpers ------------------------------------------------------------------

/// Run blocking I/O off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(std::io::Error::other)?
}

/// `file`, positioned at its start.
fn rewound(mut file: std::fs::File) -> std::io::Result<std::fs::File> {
    use std::io::Seek as _;

    file.rewind()?;
    Ok(file)
}

/// `blake3:<hex>` of everything in `file`, from its start.
fn hash_file(file: std::fs::File) -> std::io::Result<String> {
    let mut file = rewound(file)?;
    let mut hasher = blake3::Hasher::new();
    let mut chunk = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

/// A model file's identity for the hash cache: its path, size, and mtime.
type ModelStamp = (PathBuf, u64, Option<std::time::SystemTime>);

/// Hashes of model files already hashed. A model is gigabytes, and the same
/// one is used for every transcription.
static MODEL_HASHES: Mutex<Option<HashMap<ModelStamp, String>>> = Mutex::new(None);

/// `blake3:<hex>` of the model at `path`, hashed once per file version.
fn hash_model(path: &Path) -> std::io::Result<String> {
    let meta = std::fs::metadata(path)?;
    let stamp: ModelStamp = (path.to_owned(), meta.len(), meta.modified().ok());
    if let Some(hash) = MODEL_HASHES
        .lock()
        .as_ref()
        .and_then(|hashes| hashes.get(&stamp))
    {
        return Ok(hash.clone());
    }
    let hash = hash_file(std::fs::File::open(path)?)?;
    MODEL_HASHES
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert(stamp, hash.clone());
    Ok(hash)
}

/// Read a file of at most `max_bytes`.
fn read_bounded(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len > max_bytes {
        return Err(std::io::Error::other(format!(
            "the file is {len} bytes, over the {max_bytes} limit"
        )));
    }
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The last component of an absolute path.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn io_failure(step: &str, error: &std::io::Error) -> JobFailure {
    JobFailure::new(format!("failed to {step}: {error}"))
}

fn tool_failure(action: &str, error: ToolError) -> JobFailure {
    let message = format!("{action}: {error}");
    let stderr = match error {
        ToolError::Failed { stderr, .. } | ToolError::TimedOut { stderr, .. } => stderr,
        ToolError::Unavailable { .. } | ToolError::Spawn { .. } => String::new(),
    };
    JobFailure { message, stderr }
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

    #[test]
    fn sidecars_are_named_for_the_source_and_the_model() {
        assert_eq!(
            transcript_sidecar_path("/w/standup.webm", "large-v3-turbo"),
            "/w/standup.webm.large-v3-turbo.transcript.json"
        );
        assert!(
            transcript_sidecar_path("/w/a.ogg", "base.en").ends_with(TRANSCRIPT_SIDECAR_SUFFIX)
        );
    }

    #[test]
    fn languages_are_auto_or_a_short_code() {
        for language in ["auto", "en", "fr", "yue"] {
            assert!(is_transcription_language(language), "{language}");
        }
        for language in ["", "e", "EN", "english", "en-US", "-l", "e n", "auto "] {
            assert!(!is_transcription_language(language), "{language:?}");
        }
    }

    #[test]
    fn a_transcript_serializes_in_its_documented_shape() {
        let transcript = Transcript {
            version: TRANSCRIPT_VERSION,
            source: TranscriptSource {
                name: "standup.webm".to_owned(),
                blake3: "blake3:ab".to_owned(),
                size: 10,
                duration_ms: 4200,
            },
            tool: TranscriptTool {
                backend: "whisper_cpp",
                version: Some("1.9.4".to_owned()),
                model: "base.en".to_owned(),
                model_blake3: "blake3:cd".to_owned(),
                params: TranscriptParams {
                    language: "auto".to_owned(),
                },
            },
            language: Some("en".to_owned()),
            segments: vec![
                TranscriptSegment {
                    start_ms: Some(0),
                    end_ms: Some(4200),
                    text: "Hello.".to_owned(),
                    words: vec![TranscriptWord {
                        start_ms: 0,
                        end_ms: 310,
                        text: "Hello.".to_owned(),
                        p: 0.5,
                    }],
                },
                TranscriptSegment {
                    start_ms: None,
                    end_ms: None,
                    text: "Untimed.".to_owned(),
                    words: vec![],
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&transcript).unwrap(),
            serde_json::json!({
                "version": 1,
                "source": {"name": "standup.webm", "blake3": "blake3:ab", "size": 10, "duration_ms": 4200},
                "tool": {
                    "backend": "whisper_cpp",
                    "version": "1.9.4",
                    "model": "base.en",
                    "model_blake3": "blake3:cd",
                    "params": {"language": "auto"}
                },
                "language": "en",
                "segments": [
                    {
                        "start_ms": 0,
                        "end_ms": 4200,
                        "text": "Hello.",
                        "words": [{"start_ms": 0, "end_ms": 310, "text": "Hello.", "p": 0.5}]
                    },
                    {"start_ms": null, "end_ms": null, "text": "Untimed."}
                ]
            })
        );
    }

    #[test]
    fn files_hash_from_their_start_whatever_the_handle_position() {
        use std::io::{Seek as _, Write as _};

        let dir = std::env::temp_dir().join(format!("zzz-transcription-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(b"hello").unwrap();
        file.seek(std::io::SeekFrom::End(0)).unwrap();
        assert_eq!(
            hash_file(file).unwrap(),
            format!("blake3:{}", blake3::hash(b"hello").to_hex())
        );
        // cached per file version: a rewrite is hashed again
        let first = hash_model(&path).unwrap();
        assert_eq!(hash_model(&path).unwrap(), first);
        std::fs::write(&path, b"hello, again").unwrap();
        assert_ne!(hash_model(&path).unwrap(), first);

        assert!(read_bounded(&path, 4).is_err());
        assert_eq!(read_bounded(&path, 64).unwrap(), b"hello, again");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_scratch_directory_removes_itself() {
        let cache = std::env::temp_dir().join(format!("zzz-scratch-{}", uuid::Uuid::new_v4()));
        let path = {
            let scratch = ScratchDir::create(&cache).unwrap();
            std::fs::write(scratch.path.join("out.json"), "{}").unwrap();
            assert!(crate::scoped_fs::is_temp_file_name(
                scratch.path.file_name().unwrap().to_str().unwrap()
            ));
            scratch.path.clone()
        };
        assert!(!path.exists());
        std::fs::remove_dir_all(&cache).unwrap();
    }
}
