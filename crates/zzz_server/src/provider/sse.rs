//! Shared SSE stream consumer.
//!
//! Anthropic, `OpenAI`, and Gemini all stream JSON via Server-Sent
//! Events. The wire formats differ (Anthropic carries `event:`
//! discriminators, `OpenAI` uses `data: [DONE]` as a terminator, Gemini
//! just ends the stream) so the helper hands the callback raw event
//! records and lets each provider decide how to parse + dispatch.

use std::ops::ControlFlow;

use futures_util::StreamExt;
use fuz_common::JsonRpcError;
use tokio_util::sync::CancellationToken;

use super::ai_provider_error;

/// One parsed SSE event block.
///
/// `data` is the multi-line `data:` payload joined with `\n`. Callers
/// JSON-decode it themselves so they can also handle non-JSON
/// terminators like `OpenAI`'s `[DONE]`.
pub struct SseEvent {
    pub event_type: Option<String>,
    pub data: String,
}

/// Consume an SSE response stream, invoking `on_event` for each event
/// block. Stops when the stream ends, when `signal` is cancelled, or
/// when `on_event` returns `ControlFlow::Break`.
pub async fn consume_sse_stream<F>(
    response: reqwest::Response,
    provider_name: &str,
    signal: &CancellationToken,
    mut on_event: F,
) -> Result<(), JsonRpcError>
where
    F: FnMut(SseEvent) -> ControlFlow<()>,
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
        // Normalize line endings per SSE spec (RFC 8895 §9.2):
        // \r\n → \n, then lone \r → \n.
        if text.contains('\r') {
            buffer.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        } else {
            buffer.push_str(&text);
        }

        while let Some(boundary) = buffer.find("\n\n") {
            let event_text = buffer[..boundary].to_owned();
            buffer = buffer[boundary + 2..].to_owned();

            if let Some(event) = parse_sse_event(&event_text)
                && on_event(event) == ControlFlow::Break(())
            {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn parse_sse_event(event_text: &str) -> Option<SseEvent> {
    let mut event_type: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for line in event_text.lines() {
        if let Some(rest) = strip_field_prefix(line, "event") {
            event_type = Some(rest.trim().to_owned());
        } else if let Some(rest) = strip_field_prefix(line, "data") {
            data_lines.push(rest);
        }
    }

    if data_lines.is_empty() {
        return None;
    }

    Some(SseEvent {
        event_type,
        data: data_lines.join("\n"),
    })
}

/// Strip `"{field}: "` or `"{field}:"` from the start of a line.
///
/// The SSE spec allows a single optional space after the colon; some
/// servers (notably the Anthropic API) emit `data: ...` while others
/// emit `data:...`.
fn strip_field_prefix<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(field)?.strip_prefix(':')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}
