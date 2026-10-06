//! Media handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`. Inputs decode
//! strictly, matching the `z.strictObject` schemas in
//! `src/lib/action_specs.ts`. The `ffmpeg` runs are [`crate::media`]'s, which
//! confines them to file handles opened here.

use std::path::Path;
use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{
    JsonrpcError, JsonrpcErrorCode, conflict, internal_error, invalid_params, parse_strict_params,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::handlers::filesystem::{ERROR_ALREADY_EXISTS, ERROR_INVALID_PATH, scoped_fs_error};
use crate::handlers::{App, caller_account_id};
use crate::job_manager::{JobKind, JobWork};
use crate::media::{MediaContainer, create_unnamed_temp_file, remux};
use crate::scoped_fs::ScopedFsError;
use crate::tool::ToolError;
use crate::transcription::{
    TranscriptionBackend, TranscriptionRequest, is_transcription_language, run_transcription,
    transcript_sidecar_path,
};

// -- Error reasons (`error.data.reason`) --------------------------------------

/// The file's extension isn't a container zzz finalizes (`invalid_params`).
pub const ERROR_UNSUPPORTED_MEDIA_TYPE: &str = "unsupported_media_type";
/// The tool read the file and refused it — it isn't the media its extension
/// says (`invalid_params`). Carries the tool's last words as `data.stderr`.
pub const ERROR_MEDIA_INVALID: &str = "media_invalid";
/// The tool isn't installed, or isn't on the daemon's `PATH`
/// (`service_unavailable`).
pub const ERROR_TOOL_UNAVAILABLE: &str = "tool_unavailable";
/// The tool ran out of time (`timeout`).
pub const ERROR_TOOL_TIMED_OUT: &str = "tool_timed_out";
/// The file changed while it was being rewritten, so nothing was replaced
/// (`conflict`).
pub const ERROR_CHANGED_DURING_FINALIZE: &str = "changed_during_finalize";
/// Not `auto` or a short language code (`invalid_params`).
pub const ERROR_INVALID_LANGUAGE: &str = "invalid_language";

/// The language a transcription detects when none is given.
const DEFAULT_TRANSCRIPTION_LANGUAGE: &str = "auto";

/// How much of a tool's stderr rides on an error. It's text derived from the
/// file, so clients render it as text.
const ERROR_STDERR_MAX_CHARS: usize = 2000;

/// Subdirectory of the app directory that scratch files are created in.
const CACHE_DIR: &str = "cache";

/// Map a [`ToolError`] to its JSON-RPC error, prefixing the message with
/// `action`.
///
/// - the tool is missing → `service_unavailable` (-32007)
/// - it refused the file → `invalid_params` (-32602), with its stderr tail
/// - it timed out → `timeout` (-32008)
/// - it couldn't be run → `internal_error` (-32603, no reason)
pub fn tool_error(action: &str, error: &ToolError) -> JsonrpcError {
    let message = format!("{action}: {error}");
    let with_data = |code, data| JsonrpcError {
        code,
        message: message.clone(),
        data: Some(data),
    };
    match error {
        ToolError::Unavailable { .. } => with_data(
            JsonrpcErrorCode::ServiceUnavailable,
            serde_json::json!({ "reason": ERROR_TOOL_UNAVAILABLE }),
        ),
        ToolError::Failed { stderr, .. } => {
            tracing::debug!(%stderr, "{message}");
            let stderr: String = stderr.chars().take(ERROR_STDERR_MAX_CHARS).collect();
            with_data(
                JsonrpcErrorCode::InvalidParams,
                serde_json::json!({ "reason": ERROR_MEDIA_INVALID, "stderr": stderr }),
            )
        }
        ToolError::TimedOut { .. } => with_data(
            JsonrpcErrorCode::Timeout,
            serde_json::json!({ "reason": ERROR_TOOL_TIMED_OUT }),
        ),
        ToolError::Spawn { .. } => {
            tracing::warn!("{message}");
            internal_error(&message)
        }
    }
}

/// Input for `media_finalize` — twin of `MediaFinalizeInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaFinalizeInput {
    path: String,
}

/// Output of `media_finalize` — twin of `MediaFinalizeOutput`.
#[derive(Serialize)]
struct MediaFinalizeOutput {
    size: u64,
}

/// `media_finalize` — rewrite a recorded media file in place so its header
/// carries a duration and a seek index.
///
/// The file is remuxed (streams copied, nothing re-encoded) into an unnamed
/// scratch file in the app directory, then replaces the original atomically,
/// like a save. The container comes from the extension. If the file changed
/// size while `ffmpeg` ran — a recording still being appended to — nothing is
/// replaced.
///
/// # Errors
///
/// `invalid_params` for a malformed input, an extension that isn't a known
/// container, or a file `ffmpeg` refuses; `service_unavailable` without
/// `ffmpeg`; `conflict` when the file changed meanwhile; otherwise
/// [`scoped_fs_error`] / [`tool_error`].
pub async fn media_finalize(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    const ACTION: &str = "failed to finalize media";

    let input: MediaFinalizeInput = parse_strict_params(params)?;
    if !input.path.starts_with('/') {
        return Err(invalid_params(
            "path must be absolute",
            Some(ERROR_INVALID_PATH),
        ));
    }
    let Some(container) = MediaContainer::from_path(&input.path) else {
        return Err(invalid_params(
            "not a media container zzz can finalize",
            Some(ERROR_UNSUPPORTED_MEDIA_TYPE),
        ));
    };
    let ffmpeg = app.tools.ffmpeg().map_err(|e| tool_error(ACTION, &e))?;

    let (source, source_meta) = app
        .scoped_fs
        .open_file(&input.path)
        .await
        .map_err(|e| scoped_fs_error(ACTION, &e))?;
    // a second handle on the same open file, to check for changes afterward
    let source_check = source.try_clone().map_err(|e| {
        tracing::warn!(error = %e, "{ACTION}: clone the source handle");
        internal_error(ACTION)
    })?;

    let cache_dir = Path::new(&app.zzz_dir).join(CACHE_DIR);
    let scratch = tokio::task::spawn_blocking(move || {
        let scratch = create_unnamed_temp_file(&cache_dir)?;
        let writer = scratch.try_clone()?;
        Ok::<_, std::io::Error>((scratch, writer))
    })
    .await
    .map_err(std::io::Error::other)
    .and_then(|result| result);
    let (scratch, scratch_writer) = scratch.map_err(|e| {
        tracing::warn!(error = %e, "{ACTION}: create a scratch file");
        internal_error(ACTION)
    })?;

    remux(ffmpeg, container, source, scratch_writer)
        .await
        .map_err(|e| tool_error(ACTION, &e))?;

    let (now_len, scratch_len) = match (source_check.metadata(), scratch.metadata()) {
        (Ok(now), Ok(scratch)) => (now.len(), scratch.len()),
        (Err(e), _) | (_, Err(e)) => {
            tracing::warn!(error = %e, "{ACTION}: stat after the remux");
            return Err(internal_error(ACTION));
        }
    };
    if now_len != source_meta.len() {
        return Err(conflict(
            "the file changed while it was being finalized",
            Some(ERROR_CHANGED_DURING_FINALIZE),
        ));
    }

    app.scoped_fs
        .write_file_from(&input.path, scratch)
        .await
        .map_err(|e| scoped_fs_error(ACTION, &e))?;

    serde_json::to_value(MediaFinalizeOutput { size: scratch_len }).map_err(|e| {
        tracing::warn!(error = %e, "{ACTION}: serialize the output");
        internal_error(ACTION)
    })
}

/// Input for `transcription_create` — twin of `TranscriptionCreateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranscriptionCreateInput {
    path: String,
    #[serde(default, deserialize_with = "crate::handlers::present")]
    language: Option<String>,
}

/// Output of `transcription_create` — twin of `TranscriptionCreateOutput`.
#[derive(Serialize)]
struct TranscriptionCreateOutput {
    job_id: String,
}

/// `transcription_create` — queue a transcription of an audio file by the
/// local model, and return its job.
///
/// The transcript is written beside the file as
/// `<name>.<model>.transcript.json` when the job succeeds; the job's
/// `job_changed` and `transcription_progress` notifications follow it.
///
/// Everything that can be refused up front is, before a job exists: the
/// extension, the language, the tools, the file, and a transcript by this
/// model already being there (a transcript is written once — delete it to
/// transcribe again).
///
/// # Errors
///
/// `invalid_params` for a malformed input, an extension that isn't a known
/// audio container (`unsupported_media_type`), or a bad `language`;
/// `service_unavailable` (`tool_unavailable`) without `ffmpeg`, whisper.cpp,
/// or a model; `conflict` (`already_exists`) when the transcript exists;
/// otherwise [`scoped_fs_error`] for the file.
pub async fn transcription_create(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    const ACTION: &str = "failed to start a transcription";

    let input: TranscriptionCreateInput = parse_strict_params(params)?;
    let owner = caller_account_id(&ctx)?;
    if !input.path.starts_with('/') {
        return Err(invalid_params(
            "path must be absolute",
            Some(ERROR_INVALID_PATH),
        ));
    }
    let Some(container) = MediaContainer::from_path(&input.path) else {
        return Err(invalid_params(
            "not an audio file zzz can transcribe",
            Some(ERROR_UNSUPPORTED_MEDIA_TYPE),
        ));
    };
    let language = input
        .language
        .unwrap_or_else(|| DEFAULT_TRANSCRIPTION_LANGUAGE.to_owned());
    if !is_transcription_language(&language) {
        return Err(invalid_params(
            "language must be `auto` or a language code like `en`",
            Some(ERROR_INVALID_LANGUAGE),
        ));
    }
    let ffmpeg = app
        .tools
        .ffmpeg()
        .map_err(|e| tool_error(ACTION, &e))?
        .to_owned();
    let backend =
        TranscriptionBackend::from_tools(&app.tools).map_err(|e| tool_error(ACTION, &e))?;

    // the source must be there, and this model's transcript must not be
    app.scoped_fs
        .open_file(&input.path)
        .await
        .map_err(|e| scoped_fs_error(ACTION, &e))?;
    let sidecar_path = transcript_sidecar_path(&input.path, &backend.model_slug());
    match app.scoped_fs.open_file(&sidecar_path).await {
        Ok(_) => {
            return Err(conflict(
                "this model's transcript of the file already exists",
                Some(ERROR_ALREADY_EXISTS),
            ));
        }
        Err(ScopedFsError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(scoped_fs_error(ACTION, &e)),
    }

    let request = TranscriptionRequest {
        path: input.path.clone(),
        container,
        language,
        backend,
        ffmpeg,
    };
    let work: JobWork = Box::new(move |handle| Box::pin(run_transcription(handle, request)));
    let job = app
        .job_manager
        .submit(&app, owner, JobKind::Transcription, input.path, work);

    serde_json::to_value(TranscriptionCreateOutput { job_id: job.job_id }).map_err(|e| {
        tracing::warn!(error = %e, "{ACTION}: serialize the output");
        internal_error(ACTION)
    })
}
