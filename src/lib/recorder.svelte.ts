import { z } from 'zod';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { ChunkUpload } from './chunk_upload.ts';
import { DiskfilePath, type DiskfileDirectoryPath } from './diskfile_types.ts';
import type { FileBytesFetch } from './file_bytes.ts';
import {
	pick_recording_format,
	to_microphone_error_message,
	to_recording_name
} from './recording_helpers.ts';

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
 * Where a recording is: `starting` while the microphone opens and the file is
 * created, `stopping` while the last chunks upload and the file is finalized.
 */
export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/**
 * How often `Recorder.duration` and `Recorder.level` update while the
 * microphone is open, in milliseconds.
 */
export const RECORDER_TICK_INTERVAL = 100;

/** Reads how loud a live stream is right now. */
export interface LevelMeter {
	/** The current peak level, 0 (silence) to 1 (full scale). */
	read: () => number;
	/** Releases what the meter holds. */
	close: () => void;
}

/**
 * The browser the recorder runs in — everything it touches outside the app,
 * so a test can stand in for the microphone and the network.
 */
export interface RecorderDeps {
	/** `navigator.mediaDevices.getUserMedia`. */
	get_user_media: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	/** `new MediaRecorder(stream, options)`. */
	create_media_recorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
	/** `MediaRecorder.isTypeSupported` — `false` where there's no `MediaRecorder`. */
	is_type_supported: (mime_type: string) => boolean;
	/** A meter on `stream` (Web Audio), or `null` where it can't be made. */
	create_level_meter: (stream: MediaStream) => LevelMeter | null;
	/**
	 * Whether a user gesture is in effect (`navigator.userActivation.isActive`)
	 * — `true` in a browser that can't say.
	 */
	has_user_activation: () => boolean;
	fetch: FileBytesFetch;
	/** `Date.now`. */
	now: () => number;
}

/** `RecorderDeps` over the real browser, each global read when it's called. */
export const create_recorder_deps = (): RecorderDeps => ({
	get_user_media: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
	create_media_recorder: (stream, options) => new MediaRecorder(stream, options),
	is_type_supported: (mime_type) =>
		typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime_type),
	create_level_meter,
	has_user_activation: () =>
		(navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true,
	fetch: (input, init) => fetch(input, init),
	now: () => Date.now()
});

/**
 * A `LevelMeter` over Web Audio: an `AnalyserNode` on the stream, read as the
 * peak of its latest samples. It only listens — nothing is routed to the
 * speakers. `null` where there's no `AudioContext`.
 */
export function create_level_meter(stream: MediaStream): LevelMeter | null {
	if (typeof AudioContext === 'undefined') return null;
	let context: AudioContext;
	let analyser: AnalyserNode;
	let source: MediaStreamAudioSourceNode;
	try {
		context = new AudioContext();
		analyser = context.createAnalyser();
		analyser.fftSize = 1024;
		source = context.createMediaStreamSource(stream);
		source.connect(analyser);
	} catch {
		return null;
	}
	const samples = new Float32Array(analyser.fftSize);
	return {
		read: () => {
			analyser.getFloatTimeDomainData(samples);
			let peak = 0;
			for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
			return Math.min(1, peak);
		},
		close: () => {
			source.disconnect();
			void context.close();
		}
	};
}

export interface RecorderOptions extends CellOptions<typeof RecorderJson> {
	/** The browser to record with (default `create_recorder_deps()`). */
	deps?: RecorderDeps;
}

/**
 * Records the microphone to a file on disk, uploading it as it's recorded.
 *
 * App-level, so a recording carries on across route changes. The file is
 * created under its final name and grows as chunks arrive (`ChunkUpload`
 * over the backend's byte routes), so a crashed tab loses at most the last
 * chunk; stopping uploads the rest and finalizes the file (`media_finalize`)
 * so it has a duration and seeks, then — with `transcribe_on_stop` — queues
 * its transcription.
 *
 * Capture starts only in `start`, and only during a user gesture — nothing
 * the backend sends can open the microphone. `active` is true the whole time
 * it may be open, for the indicator every page shows.
 */
export class Recorder extends Cell<typeof RecorderJson> {
	chunk_duration: number = $state.raw()!;
	transcribe_on_stop: boolean = $state.raw()!;

	deps: RecorderDeps;

	status: RecorderStatus = $state.raw('idle');

	/** The file being recorded to — set once it's created, cleared when the recording ends. */
	path: DiskfilePath | null = $state.raw(null);

	/** The last recording that stopped normally, whether or not it finalized. */
	last_path: DiskfilePath | null = $state.raw(null);

	/** Why the last `start`, recording, or `stop` failed — cleared by the next `start`. */
	error: string | null = $state.raw(null);

	/** Bytes of the current recording the backend has confirmed. */
	uploaded_bytes: number = $state.raw(0);

	/**
	 * How long the current recording is so far, in milliseconds, not counting
	 * paused time. Updates every `RECORDER_TICK_INTERVAL` while recording.
	 */
	duration: number = $state.raw(0);

	/**
	 * How loud the microphone is right now, 0 to 1 — for a level meter. Updates
	 * every `RECORDER_TICK_INTERVAL` while the microphone is open (paused
	 * included), and is 0 otherwise or where it can't be measured.
	 */
	level: number = $state.raw(0);

	/** Whether the microphone may be open: any status but `idle`. */
	readonly active: boolean = $derived(this.status !== 'idle');

	#stream: MediaStream | null = null;
	#media_recorder: MediaRecorder | null = null;
	#upload: ChunkUpload | null = null;
	/** Bumped whenever a recording ends, so a `start` or `stop` still awaiting notices. */
	#generation = 0;
	#duration_before_segment = 0;
	#segment_started: number | null = null;
	#level_meter: LevelMeter | null = null;
	/** Runs while the microphone is open. */
	#tick_timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: RecorderOptions) {
		super(RecorderJson, options);
		this.deps = options.deps ?? create_recorder_deps();
		this.init();
	}

	/**
	 * Starts recording to a new file in `dir`, named for the current local
	 * time. Must be called from a user gesture (a click handler).
	 *
	 * @param dir - the directory to create the recording in
	 * @throws Error when one is already under way, there's no user gesture,
	 * the browser can't record, the microphone can't be opened, or the file
	 * can't be created — also left in `error`
	 */
	async start(dir: DiskfileDirectoryPath): Promise<void> {
		if (this.status !== 'idle') throw new Error('already recording');
		this.error = null;
		const generation = ++this.#generation;
		try {
			const { deps } = this;
			if (!deps.has_user_activation()) {
				throw new Error('recording starts only from a click or a key press');
			}
			const format = pick_recording_format(deps.is_type_supported);
			if (!format) throw new Error("this browser can't record audio");
			const { api_url } = this.app;
			if (!api_url) throw new Error('no backend to record to');

			this.status = 'starting';
			let stream: MediaStream;
			try {
				stream = await deps.get_user_media({ audio: true });
			} catch (error) {
				throw new Error(to_microphone_error_message(error));
			}
			if (generation !== this.#generation) {
				// stopped or disposed while the permission prompt was up
				stop_stream(stream);
				return;
			}
			this.#stream = stream;
			this.#level_meter = deps.create_level_meter(stream);
			this.#tick_timer = setInterval(() => this.#tick(), RECORDER_TICK_INTERVAL);

			const path = DiskfilePath.parse(
				`${dir}${to_recording_name(new Date(deps.now()))}.${format.extension}`
			);
			const upload = new ChunkUpload({
				fetch: deps.fetch,
				api_url,
				path,
				on_progress: (uploaded_bytes) => {
					if (this.#upload === upload) this.uploaded_bytes = uploaded_bytes;
				},
				on_error: (message) => {
					if (this.#upload === upload) this.#fail(`upload failed: ${message}`);
				}
			});
			await upload.create();
			if (generation !== this.#generation) return;
			this.#upload = upload;
			this.path = path;
			this.uploaded_bytes = 0;

			const media_recorder = deps.create_media_recorder(stream, { mimeType: format.mime_type });
			media_recorder.addEventListener('dataavailable', (event) => {
				upload.enqueue(event.data);
			});
			media_recorder.addEventListener('error', () => {
				if (this.#media_recorder === media_recorder) this.#fail('the recorder failed');
			});
			// the device was unplugged, or the browser revoked the permission
			for (const track of stream.getTracks()) {
				track.addEventListener('ended', () => {
					if (this.#media_recorder === media_recorder) void this.stop();
				});
			}
			this.#media_recorder = media_recorder;
			media_recorder.start(this.chunk_duration);
			this.#duration_before_segment = 0;
			this.duration = 0;
			this.status = 'recording';
			this.#start_segment();
		} catch (error) {
			if (generation === this.#generation) {
				this.#end();
				this.error = to_error_message(error);
			}
			throw error;
		}
	}

	/** Pauses a recording: the microphone stays open, nothing is recorded. */
	pause(): void {
		if (this.status !== 'recording') return;
		this.#media_recorder?.pause();
		this.#end_segment();
		this.status = 'paused';
	}

	/** Resumes a paused recording. */
	resume(): void {
		if (this.status !== 'paused') return;
		this.#media_recorder?.resume();
		this.status = 'recording';
		this.#start_segment();
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
		if (this.status === 'starting') {
			// nothing recorded yet: abandon the start
			this.#generation++;
			this.#end();
			return null;
		}
		if (this.status !== 'recording' && this.status !== 'paused') return null;
		const media_recorder = this.#media_recorder;
		const upload = this.#upload;
		const { path } = this;
		if (!media_recorder || !upload || !path) return null;
		const generation = this.#generation;
		this.#end_segment();
		this.status = 'stopping';

		// the last `dataavailable` is dispatched before `stop`
		await new Promise<void>((resolve) => {
			if (media_recorder.state === 'inactive') {
				resolve();
				return;
			}
			media_recorder.addEventListener('stop', () => resolve(), { once: true });
			media_recorder.stop();
		});
		if (generation !== this.#generation) return null;
		// close the microphone now, before the uploads finish
		this.#release_stream();

		let error: string | null = null;
		let uploaded = true;
		try {
			await upload.flush();
		} catch (flush_error) {
			uploaded = false;
			error = `upload failed: ${to_error_message(flush_error)}`;
		}
		if (generation !== this.#generation) return null;
		if (uploaded) {
			const result = await this.app.api.media_finalize({ path });
			if (generation !== this.#generation) return null;
			if (!result.ok) error = `recorded, but couldn't finalize: ${result.error.message}`;
		}

		this.#generation++;
		this.#end();
		this.error = error;
		this.last_path = path;
		// the person chose this by leaving the toggle on — nothing else starts a transcription
		if (uploaded && this.transcribe_on_stop) void this.#transcribe(path);
		return uploaded ? path : null;
	}

	/** Ends the recording without uploading more or finalizing — the session is gone. */
	override dispose(): void {
		this.#generation++;
		this.#end();
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

	/** A recording under way broke: end it and say why. */
	#fail(message: string): void {
		this.#generation++;
		const { path } = this;
		this.#end();
		this.error = message;
		this.last_path = path;
	}

	/** Releases everything a recording holds and returns to `idle`. */
	#end(): void {
		const media_recorder = this.#media_recorder;
		this.#media_recorder = null;
		if (media_recorder && media_recorder.state !== 'inactive') {
			try {
				media_recorder.stop();
			} catch {
				// already stopping
			}
		}
		this.#release_stream();
		this.#upload = null;
		this.#end_segment();
		this.path = null;
		this.status = 'idle';
	}

	#release_stream(): void {
		if (this.#tick_timer !== null) {
			clearInterval(this.#tick_timer);
			this.#tick_timer = null;
		}
		this.#level_meter?.close();
		this.#level_meter = null;
		this.level = 0;
		if (!this.#stream) return;
		stop_stream(this.#stream);
		this.#stream = null;
	}

	#start_segment(): void {
		this.#segment_started = this.deps.now();
	}

	#end_segment(): void {
		if (this.#segment_started === null) return;
		this.#duration_before_segment += this.deps.now() - this.#segment_started;
		this.#segment_started = null;
		this.duration = this.#duration_before_segment;
	}

	#tick(): void {
		if (this.#level_meter) this.level = this.#level_meter.read();
		if (this.#segment_started === null) return;
		this.duration = this.#duration_before_segment + (this.deps.now() - this.#segment_started);
	}
}

/** Stops every track, which is what closes the microphone. */
const stop_stream = (stream: MediaStream): void => {
	for (const track of stream.getTracks()) track.stop();
};
