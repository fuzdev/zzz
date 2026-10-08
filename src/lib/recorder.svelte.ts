import { z } from 'zod';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import {
	AudioCapture,
	create_audio_capture_deps,
	type AudioCaptureDeps,
	type AudioCaptureStatus
} from './audio_capture.svelte.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { ChunkUpload } from './chunk_upload.ts';
import { DiskfilePath, type DiskfileDirectoryPath } from './diskfile_types.ts';
import type { FileBytesFetch } from './file_bytes.ts';
import { to_recording_name } from './recording_helpers.ts';

export const RecorderJson = CellJson.extend({
	/**
	 * How often the browser hands over a chunk to upload, in milliseconds —
	 * the most audio a crashed tab can lose.
	 */
	chunk_duration: z.number().int().positive().default(3000),
	/** Whether a recording is transcribed, by the local model, once it's saved. */
	transcribe_on_stop: z.boolean().default(true)
}).meta({ cell_class_name: 'Recorder' });
export type RecorderJson = z.infer<typeof RecorderJson>;
export type RecorderJsonInput = z.input<typeof RecorderJson>;

/**
 * The browser the recorder runs in — the microphone, and `fetch` for the
 * upload — so a test can stand in for both.
 */
export interface RecorderDeps extends AudioCaptureDeps {
	fetch: FileBytesFetch;
}

/** `RecorderDeps` over the real browser, each global read when it's called. */
export const create_recorder_deps = (): RecorderDeps => ({
	...create_audio_capture_deps(),
	fetch: (input, init) => fetch(input, init)
});

export interface RecorderOptions extends CellOptions<typeof RecorderJson> {
	/** The browser to record with (default `create_recorder_deps()`). */
	deps?: RecorderDeps;
}

/**
 * Records the microphone to a file on disk, uploading it as it's recorded.
 *
 * App-level, so a recording carries on across route changes. `capture` owns
 * the microphone; this owns where the chunks go and what happens after. The
 * file is created under its final name and grows as chunks arrive
 * (`ChunkUpload` over the backend's byte routes), so a crashed tab loses at
 * most the last chunk; stopping uploads the rest and finalizes the file
 * (`media_finalize`) so it has a duration and seeks, then — with
 * `transcribe_on_stop` — queues its transcription.
 *
 * Capture starts only in `start`, and only during a user gesture — nothing
 * the backend sends can open the microphone. `active` is true the whole time
 * it may be open and until the recording is saved, for the indicator every
 * page shows.
 */
export class Recorder extends Cell<typeof RecorderJson> {
	chunk_duration: number = $state.raw()!;
	transcribe_on_stop: boolean = $state.raw()!;

	readonly capture: AudioCapture;

	/** The file being recorded to — set once it's created, cleared when the recording ends. */
	path: DiskfilePath | null = $state.raw(null);

	/** The last recording that stopped normally, whether or not it finalized. */
	last_path: DiskfilePath | null = $state.raw(null);

	/** Why the last `start`, recording, or `stop` failed — cleared by the next `start`. */
	error: string | null = $state.raw(null);

	/** Bytes of the current recording the backend has confirmed. */
	uploaded_bytes: number = $state.raw(0);

	/** Where the recording is: the capture's status, and `stopping` until the file is saved. */
	readonly status: AudioCaptureStatus = $derived.by(() =>
		this.capture.status !== 'idle' ? this.capture.status : this.#saving ? 'stopping' : 'idle'
	);

	/** Whether the microphone may be open or the recording is still being saved. */
	readonly active: boolean = $derived(this.status !== 'idle');

	/** How long the current recording is so far — see `AudioCapture.duration`. */
	get duration(): number {
		return this.capture.duration;
	}

	/** How loud the microphone is right now — see `AudioCapture.level`. */
	get level(): number {
		return this.capture.level;
	}

	get deps(): RecorderDeps {
		return this.#deps;
	}
	set deps(deps: RecorderDeps) {
		this.#deps = deps;
		this.capture.deps = deps;
	}

	#deps: RecorderDeps;
	#upload: ChunkUpload | null = null;
	/** True from a stop until the recording is saved, finalize included. */
	#saving = $state.raw(false);
	/** Bumped whenever a recording ends, so a `start` or `stop` still awaiting notices. */
	#generation = 0;

	constructor(options: RecorderOptions) {
		super(RecorderJson, options);
		this.#deps = options.deps ?? create_recorder_deps();
		this.capture = new AudioCapture({ deps: this.#deps });
		this.init();
	}

	/**
	 * Starts recording to a new file in `dir`, named for the current local
	 * time. Must be called from a user gesture (a click handler).
	 *
	 * @param dir - the directory to create the recording in
	 * @throws Error when one is already under way (leaving it and `error`
	 * untouched), or when there's no backend to record to, no user gesture,
	 * the browser can't record, the microphone can't be opened, or the file
	 * can't be created — each of those also left in `error`
	 */
	async start(dir: DiskfileDirectoryPath): Promise<void> {
		if (this.status !== 'idle') throw new Error('already recording');
		this.error = null;
		const generation = ++this.#generation;
		try {
			const { api_url } = this.app;
			if (!api_url) throw new Error('no backend to record to');
			const sink = await this.capture.start({
				chunk_duration: this.chunk_duration,
				open_sink: async (format, fail) => {
					const path = DiskfilePath.parse(
						`${dir}${to_recording_name(new Date(this.#deps.now()))}.${format.extension}`
					);
					const upload: ChunkUpload = new ChunkUpload({
						fetch: this.#deps.fetch,
						api_url,
						path,
						on_progress: (uploaded_bytes) => {
							if (this.#upload === upload) this.uploaded_bytes = uploaded_bytes;
						},
						on_error: (message) => fail(`upload failed: ${message}`)
					});
					await upload.create();
					return {
						path,
						upload,
						write: (chunk: Blob) => upload.enqueue(chunk),
						close: () => upload.flush()
					};
				},
				on_fail: (message) => this.#fail(message),
				on_input_ended: () => void this.stop()
			});
			if (!sink || generation !== this.#generation) return;
			this.#upload = sink.upload;
			this.path = sink.path;
			this.uploaded_bytes = 0;
		} catch (error) {
			if (generation === this.#generation) this.error = to_error_message(error);
			throw error;
		}
	}

	/** Pauses a recording: the microphone stays open, nothing is recorded. */
	pause(): void {
		this.capture.pause();
	}

	/** Resumes a paused recording. */
	resume(): void {
		this.capture.resume();
	}

	/**
	 * Stops the recording: closes the microphone, uploads what's left, and
	 * finalizes the file. A failure to upload or finalize is left in `error`
	 * — the file is still there, as far as it got.
	 *
	 * @returns the recording's path, or `null` when nothing was being
	 * recorded or the upload failed
	 */
	async stop(): Promise<DiskfilePath | null> {
		const { status } = this.capture;
		if (status === 'starting') {
			// nothing recorded yet: abandon the start
			this.#generation++;
			await this.capture.stop();
			return null;
		}
		if (status !== 'recording' && status !== 'paused') return null;
		const { path } = this;
		if (!path) return null;
		const generation = this.#generation;
		this.#saving = true;
		try {
			const stopped = await this.capture.stop();
			if (!stopped || generation !== this.#generation) return null;

			let error = stopped.ok ? null : `upload failed: ${stopped.message}`;
			if (stopped.ok) {
				const result = await this.app.api.media_finalize({ path });
				if (generation !== this.#generation) return null;
				if (!result.ok) error = `recorded, but couldn't finalize: ${result.error.message}`;
			}

			this.#upload = null;
			this.path = null;
			this.error = error;
			this.last_path = path;
			// the person chose this by leaving the toggle on — nothing else starts a transcription
			if (stopped.ok && this.transcribe_on_stop) void this.#transcribe(path);
			return stopped.ok ? path : null;
		} finally {
			this.#saving = false;
		}
	}

	/**
	 * Ends the recording without finalizing — the session is gone. Chunks the
	 * uploader already holds, and the last one the browser hands over as it
	 * stops, are still sent.
	 */
	override dispose(): void {
		this.#generation++;
		this.capture.dispose();
		this.#upload = null;
		this.path = null;
		super.dispose();
	}

	/**
	 * Queues a transcription of a saved recording. A backend with no speech
	 * model set up isn't an error here — recording works without one, and the
	 * file's view says so when asked to transcribe.
	 */
	async #transcribe(path: DiskfilePath): Promise<void> {
		const result = await this.app.jobs.transcribe(path);
		if (result.ok) return;
		const { reason } = (result.error.data ?? {}) as { reason?: unknown };
		if (reason === 'tool_unavailable') return;
		this.error ??= `recorded, but couldn't start transcribing: ${result.error.message}`;
	}

	/** The capture broke while recording: it has ended, so say why. */
	#fail(message: string): void {
		this.#generation++;
		const { path } = this;
		this.#upload = null;
		this.path = null;
		this.error = message;
		this.last_path = path;
	}
}
