/**
 * What a file is, as far as picking a view for it goes — from its extension
 * alone, since the file index says nothing about a file's type.
 *
 * @module
 */

import { TRANSCRIPT_SIDECAR_SUFFIX } from './transcript_types.ts';
import { to_path_extension } from './path_lang.ts';

/**
 * `audio` gets the player, `transcript` (a transcription's sidecar) the
 * segment view, `markdown` the source beside its preview, and `other` the
 * text editor.
 */
export type DiskfileContentKind = 'audio' | 'transcript' | 'markdown' | 'other';

/**
 * Extensions viewed as audio. Each is one the backend serves with a media
 * type (twin of `media_content_type` in `zzz_server`'s `file_bytes.rs`), so
 * an `<audio>` element can play it from the byte route. `webm` is here
 * because that's what a recording is; a `.webm` holding video plays as its
 * audio track.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
	'webm',
	'weba',
	'ogg',
	'oga',
	'opus',
	'mp3',
	'wav',
	'flac',
	'm4a',
	'aac'
]);

/** Extensions viewed as markdown. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown']);

/**
 * The content kind of the file at `path`, by its extension (case-insensitive).
 *
 * @param path - the file's path or name
 */
export const to_diskfile_content_kind = (path: string): DiskfileContentKind => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)) return 'transcript';
	const extension = to_path_extension(name);
	if (extension === null) return 'other';
	if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
	return 'other';
};
