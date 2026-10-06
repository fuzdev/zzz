/**
 * Pure helpers for transcripts: finding and reading sidecars, formatting
 * times, and turning one into text to edit.
 *
 * @module
 */

import {
	Transcript,
	TRANSCRIPT_SIDECAR_SUFFIX,
	type TranscriptSegment
} from './transcript_types.ts';

/** Whether `path` is named like a transcript sidecar. */
export const is_transcript_path = (path: string): boolean =>
	path.endsWith(TRANSCRIPT_SIDECAR_SUFFIX);

/**
 * Parses a transcript sidecar's content.
 *
 * @param content - the file's text, or `null` when it isn't loaded
 * @returns the transcript, or `null` when the content isn't one
 */
export const parse_transcript = (content: string | null): Transcript | null => {
	if (!content) return null;
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		return null;
	}
	const parsed = Transcript.safeParse(json);
	return parsed.success ? parsed.data : null;
};

/** The directory part of a path, with its trailing slash. */
const to_dir = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);

/** The last component of a path. */
const to_name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The path of the audio a sidecar was made from: the file its `source.name`
 * names, beside it. The sidecar's own name can't say — a model's name has
 * dots in it too.
 *
 * @param sidecar_path - the sidecar's absolute path
 * @param transcript - the sidecar, parsed
 */
export const to_transcript_source_path = (sidecar_path: string, transcript: Transcript): string =>
	to_dir(sidecar_path) + transcript.source.name;

/** A file that might be a transcript sidecar: its path and loaded text. */
export interface TranscriptCandidate {
	readonly path: string;
	readonly content: string | null;
}

/** A transcript sidecar found for a source. */
export interface FoundTranscript<T extends TranscriptCandidate = TranscriptCandidate> {
	file: T;
	transcript: Transcript;
}

/**
 * Finds the transcript sidecars of the audio file at `source_path` among
 * `files`: the files beside it named `<source name>.<model>.transcript.json`
 * whose content says they were made from it. Sorted by model name.
 *
 * @param files - the files to look through
 * @param source_path - the audio file's absolute path
 */
export const find_transcripts = <T extends TranscriptCandidate>(
	files: Iterable<T>,
	source_path: string
): Array<FoundTranscript<T>> => {
	const prefix = source_path + '.';
	const source_name = to_name(source_path);
	const found: Array<FoundTranscript<T>> = [];
	for (const file of files) {
		if (!file.path.startsWith(prefix) || !is_transcript_path(file.path)) continue;
		const transcript = parse_transcript(file.content);
		if (transcript?.source.name !== source_name) continue;
		found.push({ file, transcript });
	}
	return found.sort((a, b) => a.transcript.tool.model.localeCompare(b.transcript.tool.model));
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Formats a position in a recording as `m:ss`, or `h:mm:ss` from an hour up.
 *
 * @param ms - the position in milliseconds
 */
export const format_transcript_time = (ms: number): string => {
	const total_seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total_seconds / 3600);
	const minutes = Math.floor((total_seconds % 3600) / 60);
	const seconds = total_seconds % 60;
	return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
};

/** A silence at least this long starts a new paragraph in `transcript_to_text`. */
export const TRANSCRIPT_PARAGRAPH_PAUSE_MS = 2000;

/**
 * Joins a transcript's segments into paragraphs of plain text, starting a new
 * one at each pause of `pause_ms` or more. Untimed segments never break.
 *
 * @param segments - the transcript's segments, in order
 * @param pause_ms - the shortest silence that starts a new paragraph
 */
export const transcript_to_paragraphs = (
	segments: ReadonlyArray<TranscriptSegment>,
	pause_ms: number = TRANSCRIPT_PARAGRAPH_PAUSE_MS
): Array<string> => {
	const paragraphs: Array<string> = [];
	let current: Array<string> = [];
	let last_end: number | null = null;
	for (const segment of segments) {
		const text = segment.text.trim();
		if (!text) continue;
		if (
			current.length > 0 &&
			last_end !== null &&
			segment.start_ms !== null &&
			segment.start_ms - last_end >= pause_ms
		) {
			paragraphs.push(current.join(' '));
			current = [];
		}
		current.push(text);
		if (segment.end_ms !== null) last_end = segment.end_ms;
	}
	if (current.length > 0) paragraphs.push(current.join(' '));
	return paragraphs;
};

/**
 * Makes the text of an editable copy of a transcript: a link to the audio
 * beside it, then the speech as paragraphs split at pauses. The transcript
 * itself is tool output and is never edited — this is what gets edited.
 *
 * @param transcript - the transcript to copy
 */
export const transcript_to_text = (transcript: Transcript): string => {
	const paragraphs = transcript_to_paragraphs(transcript.segments);
	return [`./${transcript.source.name}`, ...paragraphs].join('\n\n') + '\n';
};

/**
 * The path an editable copy of a sidecar's text is created at: the source's
 * path plus `.md`, or `.2.md`, `.3.md`, … when that's taken.
 *
 * @param source_path - the audio file's absolute path
 * @param is_taken - whether a path is already a file
 */
export const to_transcript_copy_path = (
	source_path: string,
	is_taken: (path: string) => boolean
): string => {
	const first = `${source_path}.md`;
	if (!is_taken(first)) return first;
	for (let n = 2; ; n++) {
		const path = `${source_path}.${n}.md`;
		if (!is_taken(path)) return path;
	}
};
