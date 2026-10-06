import { z } from 'zod';

/** One word of a transcript segment, with the recognizer's confidence in it. */
export const TranscriptWord = z.strictObject({
	start_ms: z.number(),
	end_ms: z.number(),
	text: z.string(),
	/** 0 to 1. */
	p: z.number()
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

/**
 * A stretch of speech. The times are `null` from a recognizer that doesn't
 * time its text — then the segment can't be sought to.
 */
export const TranscriptSegment = z.strictObject({
	start_ms: z.number().nullable(),
	end_ms: z.number().nullable(),
	text: z.string(),
	words: z.array(TranscriptWord).optional()
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

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
export const Transcript = z.looseObject({
	version: z.number(),
	source: z.looseObject({
		/**
		 * The source's file name — it sits beside the sidecar. A sidecar is a
		 * file anyone can write, and this name becomes a path the app reads and
		 * creates files at, so anything but a single path component is refused:
		 * a transcript can't point outside its own directory.
		 */
		name: z.string().refine(is_plain_file_name, { message: 'must be a file name, not a path' }),
		/** `blake3:<hex>` of the source's bytes when it was transcribed. */
		blake3: z.string(),
		size: z.number(),
		duration_ms: z.number()
	}),
	tool: z.looseObject({
		backend: z.string(),
		version: z.string().nullable(),
		model: z.string(),
		model_blake3: z.string(),
		params: z.looseObject({ language: z.string() })
	}),
	language: z.string().nullable(),
	segments: z.array(TranscriptSegment)
});
export type Transcript = z.infer<typeof Transcript>;
