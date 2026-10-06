//! The whisper.cpp transcription backend: `whisper-cli` run as a subprocess
//! per transcription.
//!
//! Whisper is the model (open-weights speech recognition); whisper.cpp is the
//! runtime that runs it, and `whisper-cli` its command-line program. No
//! server, no port, no HTTP — the audio can't leave the machine by
//! construction. The cost is loading the model on every run.
//!
//! One run:
//!
//! - reads the audio from **standard input** (`-f -`), a handle zzz opened
//!   on PCM `ffmpeg` already decoded — never a path from the caller;
//! - prints each segment to stdout as it's decoded and progress to stderr
//!   (`-pp`), which the caller watches for live text;
//! - writes the full result, with per-token timings, to a JSON file
//!   (`-ojf -of <base>`) in a private scratch directory zzz made — the one
//!   path it's given besides the configured model.
//!
//! The JSON is the result; the printed segments are only a preview of it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use super::{TranscriptSegment, TranscriptWord};

/// How long one run may take. Generous: hours of audio on a CPU-only build.
pub const WHISPER_CPP_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Largest result file read back. A transcript is small; this only stops a
/// runaway file from being loaded.
pub const WHISPER_CPP_OUTPUT_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// The file name of the result inside the scratch directory, without the
/// `.json` `whisper-cli` appends.
pub const WHISPER_CPP_OUTPUT_BASE: &str = "out";

/// whisper.cpp, with the model it loads.
#[derive(Debug, Clone)]
pub struct WhisperCpp {
    pub bin: PathBuf,
    pub model: PathBuf,
}

/// A short name for a model file, for a transcript's file name.
///
/// The file name without `ggml-` and `.bin`, lowercased, with anything
/// outside `[a-z0-9._-]` replaced by `-`: `ggml-large-v3-turbo.bin` →
/// `large-v3-turbo`.
#[must_use]
pub fn model_slug(model: &Path) -> String {
    let name = model
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = name.strip_suffix(".bin").unwrap_or(&name);
    let name = name.strip_prefix("ggml-").unwrap_or(name);
    let slug: String = name
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches(['.', '-']);
    if slug.is_empty() {
        "model".to_owned()
    } else {
        slug.to_owned()
    }
}

/// Arguments for one run: `model`, audio on stdin, `language` (a code, or
/// `auto` to detect), progress printed, and the full JSON result written to
/// `<output_base>.json`.
#[must_use]
pub fn transcribe_args(model: &Path, language: &str, output_base: &Path) -> Vec<OsString> {
    vec![
        "-m".into(),
        model.into(),
        "-f".into(),
        "-".into(),
        "-l".into(),
        language.into(),
        "-pp".into(),
        "-ojf".into(),
        "-of".into(),
        output_base.into(),
    ]
}

/// Parse a segment line `whisper-cli` prints as it decodes:
/// `[00:00:08.000 --> 00:00:11.000]   Ask what you can do.`
///
/// `None` for any other line. The text is trimmed; the segment has no words
/// — those come from the JSON result.
#[must_use]
pub fn parse_segment_line(line: &str) -> Option<TranscriptSegment> {
    let rest = line.trim_start().strip_prefix('[')?;
    let (times, text) = rest.split_once(']')?;
    let (start, end) = times.split_once(" --> ")?;
    Some(TranscriptSegment {
        start_ms: Some(parse_timestamp_ms(start)?),
        end_ms: Some(parse_timestamp_ms(end)?),
        text: text.trim().to_owned(),
        words: Vec::new(),
    })
}

/// Parse `hh:mm:ss.mmm` to milliseconds.
fn parse_timestamp_ms(timestamp: &str) -> Option<u64> {
    let (clock, millis) = timestamp.trim().split_once('.')?;
    let mut parts = clock.split(':');
    let hours: u64 = parts.next()?.parse().ok()?;
    let minutes: u64 = parts.next()?.parse().ok()?;
    let seconds: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || millis.len() != 3 || minutes >= 60 || seconds >= 60 {
        return None;
    }
    let millis: u64 = millis.parse().ok()?;
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

/// Parse a progress line `whisper-cli -pp` prints to stderr
/// (`whisper_print_progress_callback: progress =  43%`) to `0.0..=1.0`.
#[must_use]
pub fn parse_progress_line(line: &str) -> Option<f64> {
    let (_, rest) = line.split_once("progress =")?;
    let percent: f64 = rest.trim().strip_suffix('%')?.trim().parse().ok()?;
    (0.0..=100.0).contains(&percent).then_some(percent / 100.0)
}

/// Parse the version line `whisper-cli --version` prints
/// (`whisper.cpp version: 1.9.4`).
#[must_use]
pub fn parse_version_line(output: &str) -> Option<String> {
    let (_, version) = output.lines().next()?.split_once("version:")?;
    let version = version.trim();
    (!version.is_empty()).then(|| version.to_owned())
}

// -- The JSON result -----------------------------------------------------------

#[derive(Deserialize)]
struct Output {
    #[serde(default)]
    result: OutputResult,
    #[serde(default)]
    transcription: Vec<OutputSegment>,
}

#[derive(Deserialize, Default)]
struct OutputResult {
    language: Option<String>,
}

#[derive(Deserialize)]
struct OutputSegment {
    offsets: OutputOffsets,
    text: String,
    #[serde(default)]
    tokens: Vec<OutputToken>,
}

#[derive(Deserialize)]
struct OutputToken {
    text: String,
    offsets: Option<OutputOffsets>,
    #[serde(default)]
    p: f32,
}

#[derive(Deserialize, Clone, Copy)]
struct OutputOffsets {
    from: i64,
    to: i64,
}

/// A whisper.cpp result: the detected (or given) language and the segments.
#[derive(Debug, Clone, PartialEq)]
pub struct WhisperCppOutput {
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
}

/// Parse the JSON file `whisper-cli -ojf` writes.
///
/// whisper.cpp writes token text as raw bytes, and a token can be half of a
/// multi-byte character, so the file isn't always valid UTF-8: it is read
/// lossily, and a segment with such a token keeps its text (whole there) but
/// gets no words. Segments with no text are dropped.
///
/// # Errors
///
/// A message when the file isn't the JSON shape whisper.cpp writes.
pub fn parse_output(bytes: &[u8]) -> Result<WhisperCppOutput, String> {
    let text = String::from_utf8_lossy(bytes);
    // serde would also take an array as the struct's fields in order
    if !text.trim_start().starts_with('{') {
        return Err("unreadable whisper.cpp output: not a JSON object".to_owned());
    }
    let output: Output =
        serde_json::from_str(&text).map_err(|e| format!("unreadable whisper.cpp output: {e}"))?;
    let segments = output
        .transcription
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text.trim().to_owned();
            if text.is_empty() {
                return None;
            }
            Some(TranscriptSegment {
                start_ms: Some(to_ms(segment.offsets.from)),
                end_ms: Some(to_ms(segment.offsets.to)),
                text,
                words: words_from_tokens(&segment.tokens),
            })
        })
        .collect();
    Ok(WhisperCppOutput {
        language: output.result.language.filter(|l| !l.is_empty()),
        segments,
    })
}

fn to_ms(offset: i64) -> u64 {
    u64::try_from(offset).unwrap_or(0)
}

/// Whether a token is one of the model's markers (`[_BEG_]`, `[_TT_550]`),
/// not text.
fn is_special_token(text: &str) -> bool {
    text.starts_with("[_") && text.ends_with(']')
}

/// Group a segment's tokens into words.
///
/// A token that starts with a space starts a word; any other continues the
/// one before it (a word piece, or punctuation). A word spans its tokens'
/// times and takes the lowest of their probabilities. Returns nothing when
/// any token lacks a time or holds a broken character — partial word timings
/// would point at the wrong audio.
fn words_from_tokens(tokens: &[OutputToken]) -> Vec<TranscriptWord> {
    let mut words: Vec<TranscriptWord> = Vec::new();
    for token in tokens {
        if is_special_token(&token.text) {
            continue;
        }
        let Some(offsets) = token.offsets else {
            return Vec::new();
        };
        if token.text.contains(char::REPLACEMENT_CHARACTER) {
            return Vec::new();
        }
        let p = token.p;
        match words.last_mut() {
            Some(word) if !token.text.starts_with(' ') => {
                word.text.push_str(&token.text);
                word.end_ms = to_ms(offsets.to).max(word.end_ms);
                word.p = word.p.min(p);
            }
            _ => {
                let text = token.text.trim_start();
                if text.is_empty() {
                    continue;
                }
                words.push(TranscriptWord {
                    start_ms: to_ms(offsets.from),
                    end_ms: to_ms(offsets.to),
                    text: text.to_owned(),
                    p,
                });
            }
        }
    }
    words
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
    fn model_slugs_name_the_model() {
        for (file, slug) in [
            ("/m/ggml-large-v3-turbo.bin", "large-v3-turbo"),
            ("/m/ggml-base.en.bin", "base.en"),
            ("/m/ggml-large-v3-turbo-q5_0.bin", "large-v3-turbo-q5_0"),
            ("/m/My Model (v2).bin", "my-model--v2"),
            ("/m/custom", "custom"),
            ("/m/ggml-.bin", "model"),
        ] {
            assert_eq!(model_slug(Path::new(file)), slug, "{file}");
        }
    }

    #[test]
    fn args_give_whisper_no_caller_path() {
        let args = transcribe_args(
            Path::new("/models/ggml-base.bin"),
            "auto",
            Path::new("/scratch/out"),
        );
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(
            args,
            [
                "-m",
                "/models/ggml-base.bin",
                "-f",
                "-",
                "-l",
                "auto",
                "-pp",
                "-ojf",
                "-of",
                "/scratch/out"
            ]
        );
    }

    #[test]
    fn segment_lines_parse_and_other_lines_do_not() {
        let segment =
            parse_segment_line("[00:00:08.000 --> 00:01:11.250]   Ask what you can do.").unwrap();
        assert_eq!(segment.start_ms, Some(8_000));
        assert_eq!(segment.end_ms, Some(71_250));
        assert_eq!(segment.text, "Ask what you can do.");
        assert!(segment.words.is_empty());

        // text may hold brackets and arrows of its own
        let odd = parse_segment_line("[01:00:00.001 --> 01:00:01.000]  [music] a --> b").unwrap();
        assert_eq!(odd.start_ms, Some(3_600_001));
        assert_eq!(odd.text, "[music] a --> b");

        for line in [
            "",
            "whisper_init_from_file: loading model",
            "[_BEG_]",
            "[00:00:08 --> 00:00:11]  no millis",
            "[00:61:08.000 --> 00:00:11.000]  bad minutes",
            "[garbage --> 00:00:11.000]  x",
            "00:00:08.000 --> 00:00:11.000  no brackets",
        ] {
            assert_eq!(parse_segment_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn progress_lines_parse_to_a_fraction() {
        assert_eq!(
            parse_progress_line("whisper_print_progress_callback: progress =  43%"),
            Some(0.43)
        );
        assert_eq!(parse_progress_line("x: progress = 100%"), Some(1.0));
        for line in [
            "",
            "progress",
            "progress = many%",
            "progress = 250%",
            "progress = 5",
        ] {
            assert_eq!(parse_progress_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn version_lines_parse() {
        assert_eq!(
            parse_version_line("whisper.cpp version: 1.9.4-dev\n").as_deref(),
            Some("1.9.4-dev")
        );
        assert_eq!(parse_version_line("usage: whisper-cli"), None);
        assert_eq!(parse_version_line(""), None);
    }

    const OUTPUT: &str = r#"{
        "systeminfo": "x",
        "model": {"type": "base"},
        "params": {"language": "auto"},
        "result": {"language": "en"},
        "transcription": [
            {
                "timestamps": {"from": "00:00:00,000", "to": "00:00:03,000"},
                "offsets": {"from": 0, "to": 3000},
                "text": " Hello, wonderful world.",
                "tokens": [
                    {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "id": 1, "p": 0.9},
                    {"text": " Hello", "offsets": {"from": 0, "to": 500}, "id": 2, "p": 0.9},
                    {"text": ",", "offsets": {"from": 500, "to": 600}, "id": 3, "p": 0.8},
                    {"text": " wonder", "offsets": {"from": 700, "to": 1200}, "id": 4, "p": 0.7},
                    {"text": "ful", "offsets": {"from": 1200, "to": 1500}, "id": 5, "p": 0.95},
                    {"text": " world", "offsets": {"from": 1600, "to": 2400}, "id": 6, "p": 0.6},
                    {"text": ".", "offsets": {"from": 2400, "to": 2500}, "id": 7, "p": 0.99},
                    {"text": "[_TT_150]", "offsets": {"from": 3000, "to": 3000}, "id": 8, "p": 0.1}
                ]
            },
            {
                "offsets": {"from": 3000, "to": 3000},
                "text": "  ",
                "tokens": []
            },
            {
                "offsets": {"from": 3000, "to": 5000},
                "text": " No tokens here."
            }
        ]
    }"#;

    #[test]
    fn output_parses_into_segments_and_words() {
        let output = parse_output(OUTPUT.as_bytes()).unwrap();
        assert_eq!(output.language.as_deref(), Some("en"));
        // the blank segment is dropped
        assert_eq!(output.segments.len(), 2);

        let first = &output.segments[0];
        assert_eq!(
            (first.start_ms, first.end_ms, first.text.as_str()),
            (Some(0), Some(3000), "Hello, wonderful world.")
        );
        let words: Vec<(&str, u64, u64)> = first
            .words
            .iter()
            .map(|w| (w.text.as_str(), w.start_ms, w.end_ms))
            .collect();
        assert_eq!(
            words,
            [
                ("Hello,", 0, 600),
                ("wonderful", 700, 1500),
                ("world.", 1600, 2500)
            ]
        );
        // a word is as sure as its least sure piece
        assert!((first.words[0].p - 0.8).abs() < 1e-6);
        assert!((first.words[1].p - 0.7).abs() < 1e-6);

        let second = &output.segments[1];
        assert_eq!(second.text, "No tokens here.");
        assert!(second.words.is_empty());
    }

    #[test]
    fn a_token_holding_half_a_character_costs_the_segment_its_words_only() {
        // "é" split across two tokens, as whisper.cpp writes raw token bytes
        let mut bytes = Vec::new();
        bytes.extend_from_slice(
            br#"{"result": {"language": "fr"}, "transcription": [{"offsets": {"from": 0, "to": 900}, "text": " caf"#,
        );
        bytes.extend_from_slice("é".as_bytes());
        bytes.extend_from_slice(
            br#"", "tokens": [{"text": " caf", "offsets": {"from": 0, "to": 500}, "p": 0.9}, {"text": ""#,
        );
        bytes.push(0xc3);
        bytes
            .extend_from_slice(br#"", "offsets": {"from": 500, "to": 700}, "p": 0.9}, {"text": ""#);
        bytes.push(0xa9);
        bytes.extend_from_slice(br#"", "offsets": {"from": 700, "to": 900}, "p": 0.9}]}]}"#);

        let output = parse_output(&bytes).unwrap();
        assert_eq!(output.language.as_deref(), Some("fr"));
        assert_eq!(output.segments[0].text, "café");
        assert!(output.segments[0].words.is_empty());
    }

    #[test]
    fn output_that_is_not_the_expected_json_is_an_error() {
        for bytes in [
            &b""[..],
            b"not json",
            b"[]",
            br#"{"transcription": [{"text": "x"}]}"#,
        ] {
            assert!(parse_output(bytes).is_err(), "{bytes:?}");
        }
        // nothing recognized is a result, not an error
        let empty = parse_output(br#"{"transcription": []}"#).unwrap();
        assert!(empty.segments.is_empty());
        assert_eq!(empty.language, None);
    }
}
