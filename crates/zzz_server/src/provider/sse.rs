//! Shared SSE stream consumer.
//!
//! Anthropic, `OpenAI`, and Gemini all stream JSON via Server-Sent
//! Events. The wire formats differ (Anthropic carries `event:`
//! discriminators, `OpenAI` uses `data: [DONE]` as a terminator, Gemini
//! just ends the stream) so the helper hands the callback raw event
//! records and lets each provider decide how to parse + dispatch.

use std::ops::ControlFlow;

use futures_util::StreamExt;
use fuz_http::JsonrpcError;
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
) -> Result<(), JsonrpcError>
where
    F: FnMut(SseEvent) -> ControlFlow<()>,
{
    let mut stream = response.bytes_stream();
    // Raw bytes not yet decoded — may end mid-UTF-8-sequence when a chunk
    // boundary splits a multibyte code point.
    let mut raw: Vec<u8> = Vec::new();
    // Decoded, line-ending-normalized text awaiting event boundaries.
    let mut buffer = String::new();

    loop {
        // Select over cancellation and the next chunk so an idle or hung
        // upstream stream stays cancellable — polling `is_cancelled` only
        // after a chunk arrived would block forever on a stalled stream.
        let chunk = tokio::select! {
            () = signal.cancelled() => break,
            next = stream.next() => match next {
                Some(chunk) => chunk.map_err(|e| {
                    ai_provider_error(provider_name, &format!("stream read error: {e}"))
                })?,
                None => break,
            },
        };

        raw.extend_from_slice(&chunk);
        drain_decoded(&mut raw, &mut buffer);

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

/// Move the longest complete-UTF-8 prefix of `raw` into `buffer`,
/// normalizing line endings along the way.
///
/// Only bytes that form whole UTF-8 code points are decoded; a multibyte
/// sequence split across chunk boundaries stays buffered in `raw` until
/// its continuation bytes arrive, instead of being mangled into
/// replacement characters by a per-chunk lossy decode.
fn drain_decoded(raw: &mut Vec<u8>, buffer: &mut String) {
    let consumed = match std::str::from_utf8(raw) {
        Ok(text) => {
            push_normalized(buffer, text);
            raw.len()
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            // Bytes `[..valid_up_to]` are valid UTF-8 by `Utf8Error`'s
            // contract; the `Err` arm is unreachable but keeps us off
            // `unwrap`/`unsafe`.
            if let Ok(text) = std::str::from_utf8(&raw[..valid_up_to]) {
                push_normalized(buffer, text);
            }
            valid_up_to
        }
    };
    raw.drain(..consumed);
}

/// Append `text` to `buffer`, normalizing line endings per the SSE spec
/// (RFC 8895 §9.2): `\r\n` → `\n`, then a lone `\r` → `\n`.
fn push_normalized(buffer: &mut String, text: &str) {
    if text.contains('\r') {
        buffer.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
    } else {
        buffer.push_str(text);
    }
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

    #[test]
    fn drain_decoded_holds_back_split_multibyte() {
        // "é" is 0xC3 0xA9. Feed the lead byte first: it must NOT be
        // decoded yet (a lossy decode would emit U+FFFD and corrupt it).
        let mut raw = vec![0xC3];
        let mut buffer = String::new();
        drain_decoded(&mut raw, &mut buffer);
        assert!(buffer.is_empty(), "incomplete code point must stay buffered");
        assert_eq!(raw, vec![0xC3], "lead byte retained for next chunk");

        // Continuation byte arrives — now the full "é" decodes intact.
        raw.push(0xA9);
        drain_decoded(&mut raw, &mut buffer);
        assert_eq!(buffer, "é");
        assert!(raw.is_empty());
    }

    #[test]
    fn drain_decoded_normalizes_line_endings() {
        let mut raw = b"a\r\nb\rc\nd".to_vec();
        let mut buffer = String::new();
        drain_decoded(&mut raw, &mut buffer);
        assert_eq!(buffer, "a\nb\nc\nd");
        assert!(raw.is_empty());
    }
}
