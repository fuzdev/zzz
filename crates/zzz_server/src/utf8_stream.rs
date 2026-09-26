//! Incremental UTF-8 decoding for byte streams read in arbitrary chunks.
//!
//! A per-chunk `String::from_utf8_lossy` mangles any multibyte code point a
//! chunk boundary splits — both halves become U+FFFD. `Utf8StreamDecoder`
//! holds an incomplete trailing sequence back until its continuation bytes
//! arrive, while still replacing genuinely invalid bytes with U+FFFD so they
//! can't stall decoding. Shared by the provider SSE decoder and the PTY read
//! loop.

/// Incremental UTF-8 decoder: raw chunks in, decoded text out.
#[derive(Debug, Default)]
pub struct Utf8StreamDecoder {
    /// Bytes not yet decoded — at most an incomplete trailing sequence
    /// (under 4 bytes) between calls.
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// Decode `chunk` (after any held-back bytes), passing each decoded piece
    /// of text to `emit`.
    ///
    /// Invalid bytes become U+FFFD; an incomplete sequence at the end of the
    /// chunk is held back for the next call.
    pub fn feed(&mut self, chunk: &[u8], emit: impl FnMut(&str)) {
        self.pending.extend_from_slice(chunk);
        self.drain(false, emit);
    }

    /// Flush at end of stream: an incomplete trailing sequence becomes
    /// U+FFFD, since no continuation bytes are coming.
    pub fn finish(&mut self, emit: impl FnMut(&str)) {
        self.drain(true, emit);
    }

    /// Decode `chunk` into an owned `String` — `feed` for callers that want
    /// the whole decoded text at once.
    pub fn feed_to_string(&mut self, chunk: &[u8]) -> String {
        let mut text = String::new();
        self.feed(chunk, |piece| text.push_str(piece));
        text
    }

    /// `finish` into an owned `String` (empty when nothing was held back).
    pub fn finish_to_string(&mut self) -> String {
        let mut text = String::new();
        self.finish(|piece| text.push_str(piece));
        text
    }

    /// The bytes currently held back awaiting continuation bytes.
    pub fn pending(&self) -> &[u8] {
        &self.pending
    }

    /// Move the decodable prefix of `pending` out through `emit`.
    ///
    /// Only whole code points are decoded; a multibyte sequence cut off at
    /// the end stays in `pending` (unless `at_eof`). Invalid bytes
    /// (`error_len()` is `Some`) are replaced with U+FFFD and skipped.
    fn drain(&mut self, at_eof: bool, mut emit: impl FnMut(&str)) {
        let mut start = 0;
        while start < self.pending.len() {
            match std::str::from_utf8(&self.pending[start..]) {
                Ok(text) => {
                    emit(text);
                    start = self.pending.len();
                }
                Err(e) => {
                    let valid_end = start + e.valid_up_to();
                    // Bytes `[start..valid_end]` are valid UTF-8 by
                    // `Utf8Error`'s contract; the `Err` arm is unreachable
                    // but keeps us off `unwrap`/`unsafe`.
                    if valid_end > start
                        && let Ok(text) = std::str::from_utf8(&self.pending[start..valid_end])
                    {
                        emit(text);
                    }
                    match e.error_len() {
                        Some(invalid_len) => {
                            emit(char::REPLACEMENT_CHARACTER.encode_utf8(&mut [0; 4]));
                            start = valid_end + invalid_len;
                        }
                        None if at_eof => {
                            emit(char::REPLACEMENT_CHARACTER.encode_utf8(&mut [0; 4]));
                            start = self.pending.len();
                        }
                        None => {
                            start = valid_end;
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..start);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passes_through() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"hello"), "hello");
        assert!(decoder.pending().is_empty());
    }

    #[test]
    fn split_two_byte_sequence_is_reassembled() {
        // "é" is 0xC3 0xA9 — the lead byte alone must not decode to U+FFFD.
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"caf\xC3"), "caf");
        assert_eq!(decoder.pending(), &[0xC3]);
        assert_eq!(decoder.feed_to_string(b"\xA9!"), "é!");
        assert!(decoder.pending().is_empty());
    }

    #[test]
    fn four_byte_sequence_split_byte_by_byte() {
        // U+1F600 is F0 9F 98 80.
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"\xF0"), "");
        assert_eq!(decoder.feed_to_string(b"\x9F"), "");
        assert_eq!(decoder.feed_to_string(b"\x98"), "");
        assert_eq!(decoder.feed_to_string(b"\x80"), "\u{1F600}");
        assert!(decoder.pending().is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced_and_decoding_continues() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"a\xFFb\xFE"), "a\u{FFFD}b\u{FFFD}");
        assert!(
            decoder.pending().is_empty(),
            "invalid bytes never accumulate"
        );
        assert_eq!(decoder.feed_to_string(b"c"), "c");
    }

    #[test]
    fn invalid_continuation_after_held_lead_is_replaced() {
        // A held lead byte followed by a non-continuation byte is invalid —
        // one U+FFFD for the lead, then the ASCII decodes normally.
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"\xE2\x82"), "");
        assert_eq!(decoder.feed_to_string(b"x"), "\u{FFFD}x");
        assert!(decoder.pending().is_empty());
    }

    #[test]
    fn incomplete_tail_is_replaced_at_finish() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"a\xE2\x82"), "a");
        assert_eq!(decoder.finish_to_string(), "\u{FFFD}");
        assert!(decoder.pending().is_empty());
    }

    #[test]
    fn finish_with_nothing_pending_is_empty() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b"done"), "done");
        assert_eq!(decoder.finish_to_string(), "");
    }

    #[test]
    fn empty_chunk_is_a_no_op() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.feed_to_string(b""), "");
        assert_eq!(decoder.feed_to_string(b"\xC3"), "");
        assert_eq!(decoder.feed_to_string(b""), "");
        assert_eq!(decoder.pending(), &[0xC3]);
    }
}
