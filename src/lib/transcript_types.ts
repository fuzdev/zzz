import {
	array,
	check,
	loose_object,
	message,
	nullable,
	number,
	object,
	optional,
	pipe,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { FactHashSchema } from '@fuzdev/fuz_app/primitive_schemas.ts';

/** One word of a transcript segment, with the recognizer's confidence in it. */
export const TranscriptWord = object({
	start_ms: number,
	end_ms: number,
	text: string,
	/** 0 to 1. */
	p: number
});
export type TranscriptWord = Infer<typeof TranscriptWord>;

/**
 * A stretch of speech. The times are `null` from a recognizer that doesn't
 * time its text — then the segment can't be sought to.
 */
export const TranscriptSegment = object({
	start_ms: nullable(number),
	end_ms: nullable(number),
	text: string,
	words: optional(array(TranscriptWord))
});
export type TranscriptSegment = Infer<typeof TranscriptSegment>;

/**
 * Whether `name` is one path component: not empty, not `.` or `..`, and with
 * no separator in it.
 */
export const is_plain_file_name = (name: string): boolean =>
	name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

/** What every transcript sidecar's name ends with. */
export const TRANSCRIPT_SIDECAR_SUFFIX = '.transcript.json';

/**
 * A transcript sidecar: the file a transcription writes beside its source,
 * `<source name>.<model>.transcript.json`. It records what it was made from
 * and what made it. Twin of the backend's `Transcript`.
 *
 * Loose, because it's a file on disk: one written by a newer zzz may carry
 * fields this one doesn't know.
 */
export const Transcript = loose_object({
	version: number,
	source: loose_object({
		/**
		 * The source's file name — it sits beside the sidecar. A sidecar is a
		 * file anyone can write, and this name becomes a path the app reads and
		 * creates files at, so anything but a single path component is refused:
		 * a transcript can't point outside its own directory.
		 */
		name: pipe(string, message(check(is_plain_file_name), 'must be a file name, not a path')),
		/** `blake3:<hex>` of the source's bytes when it was transcribed. */
		blake3: FactHashSchema,
		size: number,
		duration_ms: number
	}),
	tool: loose_object({
		backend: string,
		version: nullable(string),
		model: string,
		/** `blake3:<hex>` of the model file. */
		model_blake3: FactHashSchema,
		params: loose_object({ language: string })
	}),
	language: nullable(string),
	segments: array(TranscriptSegment)
});
export type Transcript = Infer<typeof Transcript>;
