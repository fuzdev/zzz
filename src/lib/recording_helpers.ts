/**
 * Pure helpers for recording audio in the browser.
 *
 * @module
 */

/** A container and codec the browser can record, and the extension its files get. */
export interface RecordingFormat {
	/** The `MediaRecorder` MIME type. */
	mime_type: string;
	/** The file extension, without the dot — one the backend can finalize and serve. */
	extension: string;
}

/**
 * The formats a recording is made in, most preferred first: Opus in WebM,
 * Opus in Ogg, then whatever the browser puts in MP4.
 */
export const RECORDING_FORMATS: ReadonlyArray<RecordingFormat> = [
	{ mime_type: 'audio/webm;codecs=opus', extension: 'webm' },
	{ mime_type: 'audio/ogg;codecs=opus', extension: 'ogg' },
	{ mime_type: 'audio/mp4', extension: 'm4a' }
];

/**
 * Picks the first of `RECORDING_FORMATS` the browser can record.
 *
 * @param is_type_supported - `MediaRecorder.isTypeSupported`
 * @returns the format, or `null` when the browser records none of them
 */
export const pick_recording_format = (
	is_type_supported: (mime_type: string) => boolean
): RecordingFormat | null =>
	RECORDING_FORMATS.find((format) => is_type_supported(format.mime_type)) ?? null;

/** The directory under the app directory that the recordings page records to. */
export const RECORDINGS_DIRNAME = 'recordings';

/**
 * The directory the recordings page records to: `recordings/` in the app
 * directory. It needs no open workspace, and keeps voice notes out of whatever
 * repository a workspace is.
 *
 * @param zzz_dir - the app directory, with its trailing slash
 */
export const to_recordings_dir = (zzz_dir: string): string => `${zzz_dir}${RECORDINGS_DIRNAME}/`;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Names a recording by when it started, in local time: `2026-01-31_09-05-07`.
 * Sorts by time and has no character a filesystem or a shell minds.
 *
 * @param date - when the recording started
 */
export const to_recording_name = (date: Date): string =>
	`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
	`_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;

/**
 * Formats a duration as `m:ss`, or `h:mm:ss` from an hour up.
 *
 * @param ms - the duration in milliseconds
 */
export const format_recording_duration = (ms: number): string => {
	const total_seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total_seconds / 3600);
	const minutes = Math.floor((total_seconds % 3600) / 60);
	const seconds = total_seconds % 60;
	return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
};

/**
 * Says why the microphone couldn't be opened, from the error `getUserMedia`
 * rejected with.
 *
 * @param error - the rejection
 */
export const to_microphone_error_message = (error: unknown): string => {
	const name = (error as { name?: unknown } | null)?.name;
	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return 'microphone permission was denied';
		case 'NotFoundError':
		case 'OverconstrainedError':
			return 'no microphone was found';
		case 'NotReadableError':
		case 'AbortError':
			return 'the microphone is in use or unavailable';
		default:
			return "couldn't open the microphone";
	}
};

/**
 * Handles `beforeunload`: while the microphone is live, asks the browser to
 * confirm leaving the page, since that ends the recording.
 *
 * @param event - the `beforeunload` event
 * @param recorder - the app's recorder, if there's an app
 * @mutates event - cancels it (`preventDefault` plus the legacy `returnValue`) to ask for confirmation
 */
export const confirm_unload_while_recording = (
	event: BeforeUnloadEvent,
	recorder: { readonly active: boolean } | undefined
): void => {
	if (!recorder?.active) return;
	event.preventDefault();
	// older browsers need a set `returnValue` to show the prompt
	event.returnValue = ''; // eslint-disable-line @typescript-eslint/no-deprecated
};
