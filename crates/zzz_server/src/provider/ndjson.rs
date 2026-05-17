//! Shared NDJSON stream consumer.
//!
//! Ollama's `/api/chat` streams newline-delimited JSON (one full JSON
//! object per line). This helper handles the byte-stream → line-split →
//! JSON-decode flow uniformly and yields each parsed object to the
//! callback. Cancellation behaves the same as the SSE consumer.

use std::ops::ControlFlow;

use futures_util::StreamExt;
use fuz_common::JsonRpcError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ai_provider_error;

/// Consume an NDJSON response stream, invoking `on_line` for each
/// parsed JSON object. Stops when the stream ends, when `signal` is
/// cancelled, or when `on_line` returns `ControlFlow::Break`.
pub async fn consume_ndjson_stream<F>(
    response: reqwest::Response,
    provider_name: &str,
    signal: &CancellationToken,
    mut on_line: F,
) -> Result<(), JsonRpcError>
where
    F: FnMut(Value) -> ControlFlow<()>,
{
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        if signal.is_cancelled() {
            break;
        }
        let chunk = chunk
            .map_err(|e| ai_provider_error(provider_name, &format!("stream read error: {e}")))?;
        let text = String::from_utf8_lossy(&chunk);
        if text.contains('\r') {
            buffer.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        } else {
            buffer.push_str(&text);
        }

        while let Some(boundary) = buffer.find('\n') {
            let line = buffer[..boundary].to_owned();
            buffer = buffer[boundary + 1..].to_owned();

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if on_line(value) == ControlFlow::Break(()) {
                return Ok(());
            }
        }
    }

    // Tail flush — Ollama's final line normally ends with `\n` but be
    // defensive in case the connection closes mid-write.
    let trimmed = buffer.trim();
    if !trimmed.is_empty()
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
    {
        let _ = on_line(value);
    }

    Ok(())
}
