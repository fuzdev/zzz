// @vitest-environment jsdom

import { test, describe, assert, beforeEach } from 'vitest';

import {
	AudioCapture,
	type AudioCaptureDeps,
	type AudioCaptureSink,
	type AudioCaptureStartOptions
} from '$lib/audio_capture.svelte.ts';

import { FakeMediaRecorder, FakeStream } from './audio_capture_test_helpers.ts';
import { flush } from './terminal_test_helpers.ts';

/** A sink that keeps chunk sizes in memory — no app, no backend. */
class MemorySink implements AudioCaptureSink {
	chunks: Array<number> = [];
	closed = false;
	close_error: Error | null = null;
	fail!: (message: string) => void;
	write(chunk: Blob): void {
		this.chunks.push(chunk.size);
	}
	close(): Promise<void> {
		this.closed = true;
		return this.close_error ? Promise.reject(this.close_error) : Promise.resolve();
	}
}

interface Harness {
	capture: AudioCapture;
	deps: AudioCaptureDeps;
	sinks_opened: Array<true>;
	sink: MemorySink;
	streams: Array<FakeStream>;
	media_recorders: Array<FakeMediaRecorder>;
	failures: Array<string>;
	input_ended: Array<true>;
	clock: { now: number };
	options: AudioCaptureStartOptions;
}

let h: Harness;

beforeEach(() => {
	const streams: Array<FakeStream> = [];
	const media_recorders: Array<FakeMediaRecorder> = [];
	const failures: Array<string> = [];
	const input_ended: Array<true> = [];
	const clock = { now: 0 };
	const sink = new MemorySink();
	const sinks_opened: Array<true> = [];
	const deps: AudioCaptureDeps = {
		get_user_media: () => {
			const stream = new FakeStream();
			streams.push(stream);
			return Promise.resolve(stream as unknown as MediaStream);
		},
		create_media_recorder: (stream, options) => {
			const media_recorder = new FakeMediaRecorder(stream as unknown as FakeStream, options);
			media_recorders.push(media_recorder);
			return media_recorder as unknown as MediaRecorder;
		},
		is_type_supported: () => true,
		create_level_meter: () => null,
		has_user_activation: () => true,
		now: () => clock.now
	};
	h = {
		capture: new AudioCapture({ deps }),
		deps,
		sinks_opened,
		sink,
		streams,
		media_recorders,
		failures,
		input_ended,
		clock,
		options: {
			chunk_duration: 1000,
			open_sink: (_format, fail) => {
				sinks_opened.push(true);
				sink.fail = fail;
				return Promise.resolve(sink);
			},
			on_fail: (message) => failures.push(message),
			on_input_ended: () => input_ended.push(true)
		}
	};
});

describe('AudioCapture', () => {
	test('records into any sink, then closes it', async () => {
		const { capture, sink, clock } = h;
		assert.strictEqual(await capture.start(h.options), sink, 'returns the opened sink');
		assert.strictEqual(capture.status, 'recording');
		h.media_recorders[0]!.emit(100);
		h.media_recorders[0]!.final_chunk_size = 20;
		clock.now += 1500;

		const stopped = capture.stop();
		assert.strictEqual(capture.status, 'stopping');
		assert.deepEqual(await stopped, { ok: true });
		assert.deepEqual(sink.chunks, [100, 20]);
		assert.ok(sink.closed);
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(capture.status, 'idle');
		assert.strictEqual(capture.duration, 1500);
	});

	test('reports a sink that fails to close', async () => {
		h.sink.close_error = new Error('disk full');
		await h.capture.start(h.options);
		assert.deepEqual(await h.capture.stop(), { ok: false, message: 'disk full' });
		assert.strictEqual(h.capture.status, 'idle');
	});

	test('a sink that fails while recording ends the capture once', async () => {
		await h.capture.start(h.options);
		h.sink.fail('gone');
		h.sink.fail('gone again');
		assert.deepEqual(h.failures, ['gone']);
		assert.strictEqual(h.capture.status, 'idle');
		assert.ok(h.streams[0]!.track.stopped);
	});

	test('a sink that can not open closes the microphone', async () => {
		h.options.open_sink = () => Promise.reject(new Error('no room'));
		try {
			await h.capture.start(h.options);
			assert.fail('expected a throw');
		} catch (error) {
			assert.strictEqual((error as Error).message, 'no room');
		}
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(h.capture.status, 'idle');
		assert.strictEqual(h.media_recorders.length, 0);
	});

	test('a track that ends is left to the owner', async () => {
		await h.capture.start(h.options);
		h.streams[0]!.track.dispatchEvent(new Event('ended'));
		await flush();
		assert.deepEqual(h.input_ended, [true]);
		assert.strictEqual(h.capture.status, 'recording', 'the owner decides how to stop');
	});

	test('a stop during the permission prompt abandons the start', async () => {
		let grant!: (stream: MediaStream) => void;
		const late_stream = new FakeStream();
		h.deps.get_user_media = () =>
			new Promise((resolve) => {
				grant = resolve;
			});
		const started = h.capture.start(h.options);
		assert.strictEqual(h.capture.status, 'starting');
		assert.ok(h.capture.active);
		assert.strictEqual(await h.capture.stop(), null);
		assert.strictEqual(h.capture.status, 'idle');

		grant(late_stream as unknown as MediaStream);
		assert.strictEqual(await started, null);
		assert.ok(late_stream.track.stopped, 'the late microphone is closed');
		assert.deepEqual(h.sinks_opened, [], 'no sink was opened');
	});

	test('a sink that fails while closing ends the capture without a stop result', async () => {
		await h.capture.start(h.options);
		h.sink.close = () => {
			h.sink.fail('broke while closing');
			return Promise.reject(new Error('broke while closing'));
		};
		assert.strictEqual(await h.capture.stop(), null);
		assert.deepEqual(h.failures, ['broke while closing'], 'reported once, through on_fail');
		assert.strictEqual(h.capture.status, 'idle');
	});

	test('dispose ends the capture without closing the sink', async () => {
		await h.capture.start(h.options);
		h.media_recorders[0]!.final_chunk_size = 5;
		h.capture.dispose();
		assert.strictEqual(h.capture.status, 'idle');
		assert.deepEqual(h.sink.chunks, [5], 'the last chunk is still handed over');
		assert.ok(!h.sink.closed);
		assert.deepEqual(h.failures, []);
	});
});
