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
            // Parse from a borrow of the buffer head; SseEvent owns its
            // String fields so the borrow is dropped before drain.
            let parsed = parse_sse_event(&buffer[..boundary]);
            // Drop event + delimiter without copying the buffer tail —
            // a stream with N events would otherwise be O(N^2) in the
            // remaining buffered bytes per event.
            let _ = buffer.drain(..boundary + 2);

            if let Some(event) = parsed
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
    fn parses_event_and_data() {
        let event = parse_sse_event("event: message_start\ndata: {\"id\":\"1\"}").unwrap();
        assert_eq!(event.event_type.as_deref(), Some("message_start"));
        assert_eq!(event.data, "{\"id\":\"1\"}");
    }

    #[test]
    fn parses_data_without_event_type() {
        let event = parse_sse_event("data: {\"x\":1}").unwrap();
        assert!(event.event_type.is_none());
        assert_eq!(event.data, "{\"x\":1}");
    }

    #[test]
    fn rejects_event_without_data() {
        assert!(parse_sse_event("event: ping").is_none());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_sse_event("").is_none());
    }

    #[test]
    fn joins_multi_line_data_with_newlines() {
        let event = parse_sse_event("data: line one\ndata: line two\ndata: line three").unwrap();
        assert_eq!(event.data, "line one\nline two\nline three");
    }

    #[test]
    fn tolerates_no_space_after_colon() {
        let event = parse_sse_event("event:foo\ndata:{\"x\":1}").unwrap();
        assert_eq!(event.event_type.as_deref(), Some("foo"));
        assert_eq!(event.data, "{\"x\":1}");
    }

    #[test]
    fn passes_through_non_json_data() {
        // OpenAI's `[DONE]` terminator — callers detect this; the parser
        // doesn't try to JSON-decode.
        let event = parse_sse_event("data: [DONE]").unwrap();
        assert_eq!(event.data, "[DONE]");
    }

    #[test]
    fn ignores_unrecognized_fields() {
        // SSE allows `id:`, `retry:`, and bare comments — we drop them
        // and key only on event + data.
        let event = parse_sse_event("id: 42\nevent: foo\ndata: bar\nretry: 100").unwrap();
        assert_eq!(event.event_type.as_deref(), Some("foo"));
        assert_eq!(event.data, "bar");
    }
}
