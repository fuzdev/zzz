//! Shared SSE stream consumer.
//!
//! Anthropic, `OpenAI`, and Gemini all stream JSON via Server-Sent
//! Events. The wire formats differ (Anthropic carries `event:`
//! discriminators, `OpenAI` uses `data: [DONE]` as a terminator, Gemini
//! marks its last chunk with a `finishReason`) so the helper hands the
//! callback raw event records and lets each provider decide how to parse +
//! dispatch — and whether the stream actually completed.
//!
//! Byte-level decoding lives in `SseDecoder`, which is pure and unit-tested:
//! UTF-8 sequences split across chunks are reassembled and invalid bytes
//! become U+FFFD (via the shared `Utf8StreamDecoder`), line endings are
//! normalized (including a `\r\n` split across chunks), and an unterminated
//! final event is flushed at end of stream.

use std::ops::ControlFlow;

use futures_util::{Stream, StreamExt};
use fuz_http::JsonrpcError;
use tokio_util::sync::CancellationToken;

use super::ai_provider_error;
use super::common::{cancelled_error, reqwest_error_message};
use crate::utf8_stream::Utf8StreamDecoder;

/// One parsed SSE event block.
///
/// `data` is the multi-line `data:` payload joined with `\n`. Callers
/// JSON-decode it themselves so they can also handle non-JSON
/// terminators like `OpenAI`'s `[DONE]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event_type: Option<String>,
    pub data: String,
}

/// Consume an SSE response stream, invoking `on_event` for each event
/// block.
///
/// Returns `Ok(())` when the stream ends (after flushing a final
/// unterminated event) or when `on_event` returns
/// `Ok(ControlFlow::Break(()))`. Whether an ended stream counts as a
/// *complete* completion is the caller's call — providers track their own
/// terminal event.
///
/// # Errors
///
/// Returns `request_cancelled` when `signal` fires, a provider-tagged error
/// when reading the stream fails, and passes through any error `on_event`
/// returns (e.g. a provider error event sent mid-stream).
pub async fn consume_sse_stream<F>(
    response: reqwest::Response,
    provider_name: &str,
    signal: &CancellationToken,
    on_event: F,
) -> Result<(), JsonrpcError>
where
    F: FnMut(SseEvent) -> Result<ControlFlow<()>, JsonrpcError>,
{
    consume_byte_stream(response.bytes_stream(), provider_name, signal, on_event).await
}

/// The transport-independent body of `consume_sse_stream`, generic over the
/// chunk stream so tests can drive it without a network.
async fn consume_byte_stream<S, B, F>(
    stream: S,
    provider_name: &str,
    signal: &CancellationToken,
    mut on_event: F,
) -> Result<(), JsonrpcError>
where
    S: Stream<Item = Result<B, reqwest::Error>>,
    B: AsRef<[u8]>,
    F: FnMut(SseEvent) -> Result<ControlFlow<()>, JsonrpcError>,
{
    let mut stream = std::pin::pin!(stream);
    let mut decoder = SseDecoder::default();

    loop {
        // Select over cancellation and the next chunk so an idle or hung
        // upstream stream stays cancellable — polling `is_cancelled` only
        // after a chunk arrived would block forever on a stalled stream.
        let chunk = tokio::select! {
            biased;
            () = signal.cancelled() => return Err(cancelled_error()),
            next = stream.next() => match next {
                Some(chunk) => chunk.map_err(|e| {
                    ai_provider_error(
                        provider_name,
                        &format!("stream read error: {}", reqwest_error_message(e)),
                    )
                })?,
                None => break,
            },
        };

        for event in decoder.feed(chunk.as_ref()) {
            if on_event(event)?.is_break() {
                return Ok(());
            }
        }
    }

    for event in decoder.finish() {
        if on_event(event)?.is_break() {
            break;
        }
    }
    Ok(())
}

/// Incremental SSE byte decoder: raw chunks in, parsed events out.
#[derive(Debug, Default)]
struct SseDecoder {
    /// Byte-level UTF-8 decoding — a multibyte sequence split by a chunk
    /// boundary waits there for its continuation bytes.
    utf8: Utf8StreamDecoder,
    /// Decoded text awaiting event boundaries.
    text: DecodedText,
}

/// Decoded, line-ending-normalized SSE text — split from `SseDecoder` so
/// decoding can append while borrowing `utf8`.
#[derive(Debug, Default)]
struct DecodedText {
    buffer: String,
    /// The last decoded character was a `\r` (already emitted as `\n`), so a
    /// `\n` opening the next decoded text completes that `\r\n` and must be
    /// skipped rather than read as a second line break.
    after_cr: bool,
    /// Some text has been decoded — the leading-BOM check is done.
    started: bool,
}

impl DecodedText {
    /// Append decoded `text`, dropping a byte-order mark at the very start
    /// of the stream (the SSE spec strips one leading U+FEFF) and
    /// normalizing line endings.
    fn push(&mut self, text: &str) {
        let text = if self.started {
            text
        } else if text.is_empty() {
            return;
        } else {
            self.started = true;
            text.strip_prefix('\u{FEFF}').unwrap_or(text)
        };
        push_normalized(&mut self.buffer, &mut self.after_cr, text);
    }
}

impl SseDecoder {
    /// Decode `chunk` and return every event it completes.
    fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let text = &mut self.text;
        self.utf8.feed(chunk, |piece| text.push(piece));
        self.take_complete_events()
    }

    /// Flush at end of stream: decode any leftover bytes (an incomplete
    /// UTF-8 tail becomes U+FFFD) and dispatch a final event that wasn't
    /// followed by a blank line.
    fn finish(&mut self) -> Vec<SseEvent> {
        let text = &mut self.text;
        self.utf8.finish(|piece| text.push(piece));
        let mut events = self.take_complete_events();
        let rest = std::mem::take(&mut self.text.buffer);
        if let Some(event) = parse_sse_event(rest.trim_end_matches('\n')) {
            events.push(event);
        }
        events
    }

    /// Pop every `\n\n`-terminated event block off the buffer.
    fn take_complete_events(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        let mut consumed = 0;
        while let Some(offset) = self.text.buffer[consumed..].find("\n\n") {
            let boundary = consumed + offset;
            if let Some(event) = parse_sse_event(&self.text.buffer[consumed..boundary]) {
                events.push(event);
            }
            consumed = boundary + 2;
        }
        // One drain per chunk — draining per event would be O(N^2) in the
        // buffered tail for a chunk carrying many events.
        let _ = self.text.buffer.drain(..consumed);
        events
    }
}

/// Append `text` to `buffer`, normalizing line endings per the SSE spec:
/// `\r\n` → `\n`, then a lone `\r` → `\n`.
///
/// A `\r` ending one piece of text is emitted as `\n` immediately and
/// `after_cr` is set, so a `\n` opening the next piece — the second half of
/// a `\r\n` split across chunks — is dropped instead of producing a fake
/// blank line (an event boundary). This is equivalent to holding the `\r`
/// back until the next chunk, without delaying event dispatch.
fn push_normalized(buffer: &mut String, after_cr: &mut bool, text: &str) {
    if text.is_empty() {
        return;
    }
    let text = if *after_cr {
        text.strip_prefix('\n').unwrap_or(text)
    } else {
        text
    };
    *after_cr = text.ends_with('\r');
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
        match parse_field(line) {
            Some(("event", value)) => {
                let value = value.trim();
                // an empty `event:` resets to the default (message) type
                event_type = (!value.is_empty()).then(|| value.to_owned());
            }
            Some(("data", value)) => data_lines.push(value),
            _ => {}
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

/// Split an SSE line into `(field, value)` per the spec.
///
/// A line starting with `:` is a comment (`None`). Otherwise the field name
/// runs to the first `:` and the value follows it, minus a single optional
/// leading space — some servers (notably the Anthropic API) emit
/// `data: ...` while others emit `data:...`. A line with no `:` at all is a
/// field name with an empty value (so a bare `data` line is an empty data
/// line).
fn parse_field(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(':') {
        return None;
    }
    Some(match line.split_once(':') {
        Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
        None => (line, ""),
    })
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

    fn data_event(data: &str) -> SseEvent {
        SseEvent {
            event_type: None,
            data: data.to_owned(),
        }
    }

    /// Feed `chunks` through a fresh decoder, then finish it.
    fn decode_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.feed(chunk));
        }
        events.extend(decoder.finish());
        events
    }

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
    fn ignores_comment_lines() {
        let event = parse_sse_event(": keepalive\ndata: x").unwrap();
        assert_eq!(event.data, "x");
        assert!(parse_sse_event(": only a comment").is_none());
    }

    #[test]
    fn field_without_colon_has_empty_value() {
        // a bare `data` line is an empty data line
        let event = parse_sse_event("data: a\ndata\ndata: b").unwrap();
        assert_eq!(event.data, "a\n\nb");
        let event = parse_sse_event("data").unwrap();
        assert_eq!(event.data, "");
        // a bare `event` line resets the type
        let event = parse_sse_event("event: foo\nevent\ndata: x").unwrap();
        assert!(event.event_type.is_none());
    }

    #[test]
    fn value_keeps_colons_after_the_first() {
        let event = parse_sse_event("data: {\"a\":\"b:c\"}").unwrap();
        assert_eq!(event.data, "{\"a\":\"b:c\"}");
    }

    #[test]
    fn leading_bom_is_stripped() {
        let events = decode_all(&[b"\xEF\xBB\xBFdata: x\n\n"]);
        assert_eq!(events, vec![data_event("x")]);
    }

    #[test]
    fn leading_bom_split_across_chunks_is_stripped() {
        let events = decode_all(&[b"\xEF", b"\xBB\xBFdata: x\n\n"]);
        assert_eq!(events, vec![data_event("x")]);
    }

    #[test]
    fn bom_after_stream_start_is_kept() {
        let events = decode_all(&[b"data: a\n\n", b"\xEF\xBB\xBFdata: b\n\n"]);
        // not at stream start — the line `\u{FEFF}data: b` is an unknown field
        assert_eq!(events, vec![data_event("a")]);
    }

    #[test]
    fn feed_holds_back_split_multibyte() {
        // "é" is 0xC3 0xA9. Feed the lead byte first: it must NOT be
        // decoded yet (a lossy decode would emit U+FFFD and corrupt it).
        let mut decoder = SseDecoder::default();
        assert!(decoder.feed(&[0xC3]).is_empty());
        assert!(
            decoder.text.buffer.is_empty(),
            "incomplete code point must stay buffered"
        );
        assert_eq!(
            decoder.utf8.pending(),
            &[0xC3],
            "lead byte retained for next chunk"
        );

        // Continuation byte arrives — now the full "é" decodes intact.
        assert!(decoder.feed(&[0xA9]).is_empty());
        assert_eq!(decoder.text.buffer, "é");
        assert!(decoder.utf8.pending().is_empty());
    }

    #[test]
    fn feed_normalizes_line_endings() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.feed(b"a\r\nb\rc\nd").is_empty());
        assert_eq!(decoder.text.buffer, "a\nb\nc\nd");
        assert!(decoder.utf8.pending().is_empty());
    }

    #[test]
    fn crlf_split_across_chunks_is_one_line_break() {
        // `data: a\r` | `\ndata: b\r\n\r\n` — the split `\r\n` must not be
        // read as `\r` + `\n` (a blank line, i.e. a fake event boundary
        // between the two data lines).
        let events = decode_all(&[b"data: a\r", b"\ndata: b\r\n\r\n"]);
        assert_eq!(events, vec![data_event("a\nb")]);
    }

    #[test]
    fn crlf_boundary_split_across_chunks_still_dispatches() {
        // The event-terminating blank line itself split mid-`\r\n`.
        let events = decode_all(&[b"data: a\r\n\r", b"\ndata: b\r\n\r\n"]);
        assert_eq!(events, vec![data_event("a"), data_event("b")]);
    }

    #[test]
    fn cr_cr_split_across_chunks_is_two_line_breaks() {
        // A lone `\r` followed by another `\r` is two line endings — still
        // an event boundary even when split.
        let events = decode_all(&[b"data: a\r", b"\rdata: b\r\r"]);
        assert_eq!(events, vec![data_event("a"), data_event("b")]);
    }

    #[test]
    fn invalid_utf8_is_replaced_and_decoding_continues() {
        // 0xFF is never valid UTF-8 — it must become U+FFFD rather than
        // stalling the decoder while held-back bytes grow forever.
        let events = decode_all(&[b"data: a\xFFb\n\n", b"data: next\n\n"]);
        assert_eq!(events, vec![data_event("a\u{FFFD}b"), data_event("next")]);
    }

    #[test]
    fn invalid_utf8_does_not_accumulate_raw() {
        let mut decoder = SseDecoder::default();
        let _ = decoder.feed(b"\xFF\xFEdata: x");
        assert!(decoder.utf8.pending().is_empty());
        assert_eq!(decoder.text.buffer, "\u{FFFD}\u{FFFD}data: x");
    }

    #[test]
    fn final_event_without_blank_line_is_flushed() {
        let events = decode_all(&[b"data: one\n\n", b"data: two"]);
        assert_eq!(events, vec![data_event("one"), data_event("two")]);
    }

    #[test]
    fn final_event_with_single_newline_is_flushed() {
        let events = decode_all(&[b"event: done\ndata: two\n"]);
        assert_eq!(
            events,
            vec![SseEvent {
                event_type: Some("done".to_owned()),
                data: "two".to_owned(),
            }],
        );
    }

    #[test]
    fn incomplete_utf8_tail_is_replaced_at_eof() {
        let events = decode_all(&[b"data: a\xC3"]);
        assert_eq!(events, vec![data_event("a\u{FFFD}")]);
    }

    #[test]
    fn many_events_in_one_chunk() {
        let events = decode_all(&[b"data: 1\n\ndata: 2\n\ndata: 3\n\n"]);
        assert_eq!(
            events,
            vec![data_event("1"), data_event("2"), data_event("3")]
        );
    }

    type Chunk = Result<&'static [u8], reqwest::Error>;

    #[tokio::test]
    async fn consume_flushes_final_event_at_eof() {
        let chunks: Vec<Chunk> = vec![Ok(b"data: one\n\n"), Ok(b"data: two")];
        let mut seen = Vec::new();
        consume_byte_stream(
            futures_util::stream::iter(chunks),
            "test",
            &CancellationToken::new(),
            |event| {
                seen.push(event.data);
                Ok(ControlFlow::Continue(()))
            },
        )
        .await
        .unwrap();
        assert_eq!(seen, vec!["one", "two"]);
    }

    #[tokio::test]
    async fn consume_stops_on_break() {
        let chunks: Vec<Chunk> = vec![Ok(b"data: one\n\ndata: two\n\n")];
        let mut seen = Vec::new();
        consume_byte_stream(
            futures_util::stream::iter(chunks),
            "test",
            &CancellationToken::new(),
            |event| {
                seen.push(event.data);
                Ok(ControlFlow::Break(()))
            },
        )
        .await
        .unwrap();
        assert_eq!(seen, vec!["one"]);
    }

    #[tokio::test]
    async fn consume_propagates_callback_error() {
        let chunks: Vec<Chunk> = vec![Ok(b"data: bad\n\n")];
        let error = consume_byte_stream(
            futures_util::stream::iter(chunks),
            "test",
            &CancellationToken::new(),
            |_| Err(ai_provider_error("test", "boom")),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("boom"));
    }

    #[tokio::test]
    async fn consume_returns_cancelled_when_signal_fires() {
        let signal = CancellationToken::new();
        signal.cancel();
        // A stream that never yields — cancellation must still win.
        let error = consume_byte_stream(
            futures_util::stream::pending::<Chunk>(),
            "test",
            &signal,
            |_| Ok(ControlFlow::Continue(())),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, fuz_http::JsonrpcErrorCode::RequestCancelled);
    }
}
