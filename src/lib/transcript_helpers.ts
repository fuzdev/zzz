/**
 * Pure helpers for transcripts: finding and reading sidecars, formatting
 * times, and turning one into text to edit.
 *
 * @module
 */

import { parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	is_plain_file_name,
	Transcript,
	TRANSCRIPT_MODEL_SLUG_REGEX,
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
	const parsed = parse(Transcript, json);
	return parsed.ok ? parsed.value : null;
};

/** The directory part of a path, with its trailing slash. */
const to_dir = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);

/** The last component of a path. */
const to_name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The name of the audio file a sidecar was made from, parsed from the
 * sidecar's own name, `<source name>.<model>.transcript.json`: the model's
 * slug never has a `.`, so the source's name is everything before the last
 * one. The name is the link between the two (the content's `source.blake3`
 * is the source's identity), so renaming the pair rewrites no content.
 *
 * @param sidecar_path - the sidecar's path, or its name
 * @returns the source's name, `null` when the name isn't a sidecar's
 */
export const to_transcript_source_name = (sidecar_path: string): string | null => {
	const name = to_name(sidecar_path);
	if (!name.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)) return null;
	const stem = name.slice(0, -TRANSCRIPT_SIDECAR_SUFFIX.length);
	const dot = stem.lastIndexOf('.');
	if (dot === -1) return null;
	const source_name = stem.slice(0, dot);
	if (!TRANSCRIPT_MODEL_SLUG_REGEX.test(stem.slice(dot + 1))) return null;
	return is_plain_file_name(source_name) ? source_name : null;
};

/**
 * The path of the audio a sidecar was made from: the file its name names,
 * beside it (`to_transcript_source_name`) — never outside the sidecar's
 * directory.
 *
 * @param sidecar_path - the sidecar's absolute path
 * @returns the source's path, `null` when the name isn't a sidecar's
 */
export const to_transcript_source_path = (sidecar_path: string): string | null => {
	const source_name = to_transcript_source_name(sidecar_path);
	return source_name === null ? null : to_dir(sidecar_path) + source_name;
};

/** Whether the file at `path` is named as a transcript sidecar of `source_path`. */
const is_transcript_of = (path: string, source_path: string): boolean =>
	path.startsWith(source_path + '.') && to_transcript_source_path(path) === source_path;

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
 * The files that are named as transcript sidecars of the audio file at
 * `source_path`: the ones beside it named
 * `<source name>.<model>.transcript.json`. Their contents are read for the
 * transcript itself (`find_transcripts`), so a caller loads these first.
 *
 * @param files - the files to look through
 * @param source_path - the audio file's absolute path
 */
export const find_transcript_candidates = <T extends { readonly path: string }>(
	files: Iterable<T>,
	source_path: string
): Array<T> => {
	const candidates: Array<T> = [];
	for (const file of files) {
		if (is_transcript_of(file.path, source_path)) candidates.push(file);
	}
	return candidates;
};

/**
 * The paths among `paths` named as transcript sidecars of the audio file at
 * `source_path` — `find_transcript_candidates` over bare paths.
 *
 * @param paths - the paths to look through
 * @param source_path - the audio file's absolute path
 */
export const find_transcript_candidate_paths = (
	paths: Iterable<string>,
	source_path: string
): Array<string> => {
	const candidates: Array<string> = [];
	for (const path of paths) {
		if (is_transcript_of(path, source_path)) candidates.push(path);
	}
	return candidates;
};

/**
 * Finds the transcript sidecars of the audio file at `source_path` among
 * `files`: the files beside it named `<source name>.<model>.transcript.json`
 * whose content is a transcript. Sorted by model name. A candidate whose
 * content isn't loaded isn't found — load the `find_transcript_candidates`
 * first.
 *
 * @param files - the files to look through
 * @param source_path - the audio file's absolute path
 */
export const find_transcripts = <T extends TranscriptCandidate>(
	files: Iterable<T>,
	source_path: string
): Array<FoundTranscript<T>> => {
	const found: Array<FoundTranscript<T>> = [];
	for (const file of find_transcript_candidates(files, source_path)) {
		const transcript = parse_transcript(file.content);
		if (transcript) found.push({ file, transcript });
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
 * @param source_name - the audio's file name (`to_transcript_source_name`)
 */
export const transcript_to_text = (transcript: Transcript, source_name: string): string => {
	const paragraphs = transcript_to_paragraphs(transcript.segments);
	return [`./${source_name}`, ...paragraphs].join('\n\n') + '\n';
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
