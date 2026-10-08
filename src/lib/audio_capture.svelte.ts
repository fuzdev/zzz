/**
 * Microphone capture in the browser, handing each recorded chunk to a sink —
 * knowing nothing about where the chunks go or what the app does with them.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import {
	pick_recording_format,
	to_microphone_error_message,
	type RecordingFormat
} from './recording_helpers.ts';

// TODO: extract to fuz_ui (with its sink interface) once a second app records —
// cord is the expected one; the server-backed chunk-upload sink pairs with the
// byte routes when those move into the spine

/**
 * Where a capture is: `starting` while the microphone opens and the sink
 * opens, `stopping` while the last chunk is handed over and the sink closes.
 */
export type AudioCaptureStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/**
 * How often `AudioCapture.duration` and `AudioCapture.level` update while the
 * microphone is open, in milliseconds.
 */
export const AUDIO_CAPTURE_TICK_INTERVAL = 100;

/** Reads how loud a live stream is right now. */
export interface LevelMeter {
	/** The current peak level, 0 (silence) to 1 (full scale). */
	read: () => number;
	/** Releases what the meter holds. */
	close: () => void;
}

/**
 * The browser a capture runs in — everything it touches outside itself, so a
 * test can stand in for the microphone and the clock.
 */
export interface AudioCaptureDeps {
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
	/** `Date.now`. */
	now: () => number;
}

/** `AudioCaptureDeps` over the real browser, each global read when it's called. */
export const create_audio_capture_deps = (): AudioCaptureDeps => ({
	get_user_media: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
	create_media_recorder: (stream, options) => new MediaRecorder(stream, options),
	is_type_supported: (mime_type) =>
		typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime_type),
	create_level_meter,
	has_user_activation: () =>
		(navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true,
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

/** Where a capture's chunks go — a file on a backend, local storage, anywhere. */
export interface AudioCaptureSink {
	/** Takes the next chunk, after every chunk written before it. */
	write: (chunk: Blob) => void;
	/**
	 * Waits for every written chunk to land.
	 *
	 * @throws Error when they didn't
	 */
	close: () => Promise<void>;
}

export interface AudioCaptureStartOptions<TSink extends AudioCaptureSink = AudioCaptureSink> {
	/**
	 * How often the browser hands over a chunk, in milliseconds — the most a
	 * sink can lose when the tab crashes.
	 */
	chunk_duration: number;
	/**
	 * Opens the sink for a capture in `format`, once the microphone is open.
	 * `fail` ends the capture with a reason, for a sink that breaks while
	 * chunks are still arriving; it's ignored once the capture has ended.
	 *
	 * @throws Error when the sink can't be opened, which ends the start
	 */
	open_sink: (format: RecordingFormat, fail: (message: string) => void) => Promise<TSink>;
	/** Called when a capture under way breaks and has ended, with why. */
	on_fail: (message: string) => void;
	/**
	 * Called when the microphone's track ends on its own — the device was
	 * unplugged, or the browser revoked the permission. Typically stops the
	 * capture the way its owner normally does.
	 */
	on_input_ended: () => void;
}

/** What a stop got from the sink: `ok`, or why closing it failed. */
export type AudioCaptureStopResult = Result<object, { message: string }>;

export interface AudioCaptureOptions {
	/** The browser to capture with (default `create_audio_capture_deps()`). */
	deps?: AudioCaptureDeps;
}

/**
 * Captures the microphone with `MediaRecorder`, handing each chunk to a sink
 * as it's recorded, with pause and resume, the duration so far, and a level.
 *
 * Capture starts only in `start`, and only during a user gesture. `active` is
 * true the whole time the microphone may be open, for an indicator.
 */
export class AudioCapture {
	deps: AudioCaptureDeps;

	status: AudioCaptureStatus = $state.raw('idle');

	/**
	 * How long the current capture is so far, in milliseconds, not counting
	 * paused time. Updates every `AUDIO_CAPTURE_TICK_INTERVAL` while recording,
	 * and keeps its last value once the capture ends.
	 */
	duration: number = $state.raw(0);

	/**
	 * How loud the microphone is right now, 0 to 1 — for a level meter. Updates
	 * every `AUDIO_CAPTURE_TICK_INTERVAL` while the microphone is open (paused
	 * included), and is 0 otherwise or where it can't be measured.
	 */
	level: number = $state.raw(0);

	/** Whether the microphone may be open: any status but `idle`. */
	readonly active: boolean = $derived(this.status !== 'idle');

	#stream: MediaStream | null = null;
	#media_recorder: MediaRecorder | null = null;
	#sink: AudioCaptureSink | null = null;
	/** Bumped whenever a capture ends, so a `start` or `stop` still awaiting notices. */
	#generation = 0;
	#duration_before_segment = 0;
	#segment_started: number | null = null;
	#level_meter: LevelMeter | null = null;
	/** Runs while the microphone is open. */
	#tick_timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: AudioCaptureOptions = {}) {
		this.deps = options.deps ?? create_audio_capture_deps();
	}

	/**
	 * Opens the microphone and the sink, and starts recording. Must be called
	 * from a user gesture (a click handler).
	 *
	 * @returns the opened sink once recording, or `null` when the capture was
	 * stopped or disposed before it got there
	 * @throws Error when one is already under way (leaving it untouched), or
	 * when there's no user gesture, the browser can't record, the microphone
	 * can't be opened, or the sink can't be opened — each of those after
	 * closing whatever the start opened
	 */
	async start<TSink extends AudioCaptureSink>(
		options: AudioCaptureStartOptions<TSink>
	): Promise<TSink | null> {
		if (this.status !== 'idle') throw new Error('already recording');
		const generation = ++this.#generation;
		try {
			const { deps } = this;
			if (!deps.has_user_activation()) {
				throw new Error('recording starts only from a click or a key press');
			}
			const format = pick_recording_format(deps.is_type_supported);
			if (!format) throw new Error("this browser can't record audio");

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
				return null;
			}
			this.#stream = stream;
			this.#level_meter = deps.create_level_meter(stream);
			this.#tick_timer = setInterval(() => this.#tick(), AUDIO_CAPTURE_TICK_INTERVAL);

			const sink = await options.open_sink(format, (message) => {
				if (generation === this.#generation) this.#fail(message, options.on_fail);
			});
			if (generation !== this.#generation) return null;
			this.#sink = sink;

			const media_recorder = deps.create_media_recorder(stream, { mimeType: format.mime_type });
			media_recorder.addEventListener('dataavailable', (event) => {
				sink.write(event.data);
			});
			media_recorder.addEventListener('error', () => {
				if (this.#media_recorder === media_recorder) {
					this.#fail('the recorder failed', options.on_fail);
				}
			});
			for (const track of stream.getTracks()) {
				track.addEventListener('ended', () => {
					if (this.#media_recorder === media_recorder) options.on_input_ended();
				});
			}
			this.#media_recorder = media_recorder;
			media_recorder.start(options.chunk_duration);
			this.#duration_before_segment = 0;
			this.duration = 0;
			this.status = 'recording';
			this.#start_segment();
			return sink;
		} catch (error) {
			if (generation === this.#generation) this.#end();
			throw error;
		}
	}

	/** Pauses a capture: the microphone stays open, nothing is recorded. */
	pause(): void {
		if (this.status !== 'recording') return;
		this.#media_recorder?.pause();
		this.#end_segment();
		this.status = 'paused';
	}

	/** Resumes a paused capture. */
	resume(): void {
		if (this.status !== 'paused') return;
		this.#media_recorder?.resume();
		this.status = 'recording';
		this.#start_segment();
	}

	/**
	 * Stops the capture: hands the last chunk to the sink, closes the
	 * microphone, and closes the sink. A capture still starting is abandoned.
	 *
	 * @returns how closing the sink went, or `null` when nothing was being
	 * recorded, or the capture failed or was disposed while stopping
	 */
	async stop(): Promise<AudioCaptureStopResult | null> {
		if (this.status === 'starting') {
			// nothing recorded yet: abandon the start
			this.#generation++;
			this.#end();
			return null;
		}
		if (this.status !== 'recording' && this.status !== 'paused') return null;
		const media_recorder = this.#media_recorder;
		const sink = this.#sink;
		if (!media_recorder || !sink) return null;
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
		// close the microphone now, before the sink finishes
		this.#release_stream();

		let result: AudioCaptureStopResult = { ok: true };
		try {
			await sink.close();
		} catch (error) {
			result = { ok: false, message: to_error_message(error) };
		}
		if (generation !== this.#generation) return null;
		this.#generation++;
		this.#end();
		return result;
	}

	/**
	 * Ends the capture without closing the sink. The last chunk the browser
	 * hands over as it stops is still written to it.
	 */
	dispose(): void {
		this.#generation++;
		this.#end();
	}

	/** A capture under way broke: end it and say why. */
	#fail(message: string, on_fail: (message: string) => void): void {
		this.#generation++;
		this.#end();
		on_fail(message);
	}

	/** Releases everything a capture holds and returns to `idle`. */
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
		this.#sink = null;
		this.#end_segment();
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
