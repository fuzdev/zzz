// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { RECORDER_TICK_INTERVAL, type Recorder, type RecorderDeps } from '$lib/recorder.svelte.ts';
import { DiskfileDirectoryPath } from '$lib/diskfile_types.ts';

import { FakeByteRoutes, blob_of } from './byte_route_test_helpers.ts';
import { flush, result_error, result_ok } from './terminal_test_helpers.ts';

const DIR = DiskfileDirectoryPath.parse('/w/');
/** 2026-01-31 09:05:07 local time. */
const STARTED = new Date(2026, 0, 31, 9, 5, 7).getTime();
const PATH = '/w/2026-01-31_09-05-07.webm';

class FakeTrack extends EventTarget {
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

class FakeStream {
	readonly track = new FakeTrack();
	getTracks(): Array<FakeTrack> {
		return [this.track];
	}
}

class FakeMediaRecorder extends EventTarget {
	state: 'inactive' | 'recording' | 'paused' = 'inactive';
	timeslice: number | undefined;
	readonly stream: FakeStream;
	readonly options: MediaRecorderOptions;
	constructor(stream: FakeStream, options: MediaRecorderOptions) {
		super();
		this.stream = stream;
		this.options = options;
	}
	start(timeslice?: number): void {
		this.state = 'recording';
		this.timeslice = timeslice;
	}
	pause(): void {
		this.state = 'paused';
	}
	resume(): void {
		this.state = 'recording';
	}
	/** Hands over a chunk, as the browser does every timeslice. */
	emit(size: number): void {
		this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob_of(size) }));
	}
	/** The last chunk is dispatched before `stop`, like the real one. */
	final_chunk_size = 0;
	stop(): void {
		this.state = 'inactive';
		if (this.final_chunk_size) this.emit(this.final_chunk_size);
		this.dispatchEvent(new Event('stop'));
	}
}

interface Harness {
	app: Frontend;
	recorder: Recorder;
	routes: FakeByteRoutes;
	streams: Array<FakeStream>;
	media_recorders: Array<FakeMediaRecorder>;
	finalized: Array<{ path: string }>;
	transcribed: Array<{ path: string }>;
	meters: Array<{ level: number; closed: boolean }>;
	/** The fake clock, in milliseconds. */
	clock: { now: number };
	deps: RecorderDeps & {
		user_active: boolean;
		supported: (mime_type: string) => boolean;
		/** Set to make `get_user_media` reject, or to hold it open. */
		get_user_media_override: (() => Promise<MediaStream>) | null;
	};
	finalize_result: unknown;
	transcribe_result: unknown;
}

let h: Harness;

beforeEach(() => {
	const routes = new FakeByteRoutes();
	const streams: Array<FakeStream> = [];
	const media_recorders: Array<FakeMediaRecorder> = [];
	const finalized: Array<{ path: string }> = [];
	const transcribed: Array<{ path: string }> = [];
	const meters: Array<{ level: number; closed: boolean }> = [];
	const clock = { now: STARTED };
	const app = new Frontend({ api_url: '/api' });
	const harness = {
		finalize_result: result_ok({ size: 1 }),
		transcribe_result: result_ok({ job_id: '00000000-0000-4000-8000-000000000000' })
	} as Harness;
	const deps: Harness['deps'] = {
		user_active: true,
		supported: () => true,
		get_user_media_override: null,
		get_user_media: () => {
			if (deps.get_user_media_override) return deps.get_user_media_override();
			const stream = new FakeStream();
			streams.push(stream);
			return Promise.resolve(stream as unknown as MediaStream);
		},
		create_media_recorder: (stream, options) => {
			const media_recorder = new FakeMediaRecorder(stream as unknown as FakeStream, options);
			media_recorders.push(media_recorder);
			return media_recorder as unknown as MediaRecorder;
		},
		is_type_supported: (mime_type) => deps.supported(mime_type),
		create_level_meter: () => {
			const meter = { level: 0.5, closed: false };
			meters.push(meter);
			return {
				read: () => meter.level,
				close: () => {
					meter.closed = true;
				}
			};
		},
		has_user_activation: () => deps.user_active,
		fetch: routes.fetch,
		now: () => clock.now
	};
	app.recorder.deps = deps;
	(app as unknown as { api: unknown }).api = {
		media_finalize: (input: { path: string }) => {
			finalized.push(input);
			return Promise.resolve(harness.finalize_result);
		},
		transcription_create: (input: { path: string }) => {
			transcribed.push(input);
			return Promise.resolve(harness.transcribe_result);
		}
	};
	h = Object.assign(harness, {
		app,
		recorder: app.recorder,
		routes,
		streams,
		media_recorders,
		finalized,
		transcribed,
		meters,
		clock,
		deps
	});
});

afterEach(() => {
	h.app.dispose();
});

const start_error = async (dir: DiskfileDirectoryPath = DIR): Promise<string> => {
	try {
		await h.recorder.start(dir);
	} catch (error) {
		return (error as Error).message;
	}
	return '';
};

describe('Recorder.start', () => {
	test('opens the microphone, creates the file, and records in chunks', async () => {
		const { recorder, routes, streams, media_recorders } = h;
		assert.strictEqual(recorder.status, 'idle');
		assert.ok(!recorder.active);

		const started = recorder.start(DIR);
		assert.strictEqual(recorder.status, 'starting');
		assert.ok(recorder.active, 'active while the microphone opens');
		await started;

		assert.strictEqual(recorder.status, 'recording');
		assert.strictEqual(recorder.path, PATH);
		assert.strictEqual(streams.length, 1);
		assert.deepEqual(media_recorders[0]!.options, { mimeType: 'audio/webm;codecs=opus' });
		assert.strictEqual(media_recorders[0]!.timeslice, recorder.chunk_duration);
		assert.deepEqual(routes.requests, [{ method: 'POST', path: PATH, offset: null, size: 0 }]);

		media_recorders[0]!.emit(100);
		media_recorders[0]!.emit(50);
		await flush();
		assert.strictEqual(routes.size_of(PATH), 150);
		assert.strictEqual(recorder.uploaded_bytes, 150);
	});

	test('names the file for the format the browser records', async () => {
		h.deps.supported = (mime_type) => mime_type.startsWith('audio/ogg');
		await h.recorder.start(DIR);
		assert.strictEqual(h.recorder.path, '/w/2026-01-31_09-05-07.ogg');
		assert.deepEqual(h.media_recorders[0]!.options, { mimeType: 'audio/ogg;codecs=opus' });
	});

	test('refuses without a user gesture, before touching the microphone', async () => {
		h.deps.user_active = false;
		assert.include(await start_error(), 'only from a click');
		assert.strictEqual(h.streams.length, 0);
		assert.strictEqual(h.recorder.status, 'idle');
		assert.include(h.recorder.error, 'only from a click');
	});

	test('refuses when the browser can not record', async () => {
		h.deps.supported = () => false;
		assert.include(await start_error(), "can't record");
		assert.strictEqual(h.streams.length, 0);
	});

	test('refuses without a backend to record to', async () => {
		(h.app as unknown as { api_url: string | null }).api_url = null;
		assert.include(await start_error(), 'no backend');
		assert.strictEqual(h.streams.length, 0);
	});

	test('reports a denied microphone and returns to idle', async () => {
		h.deps.get_user_media_override = () =>
			Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
		assert.strictEqual(await start_error(), 'microphone permission was denied');
		assert.strictEqual(h.recorder.status, 'idle');
		assert.strictEqual(h.recorder.error, 'microphone permission was denied');
		assert.strictEqual(h.routes.requests.length, 0, 'no file created');
	});

	test('closes the microphone when the file can not be created', async () => {
		h.routes.files.set(PATH, []);
		assert.strictEqual(await start_error(), 'already exists');
		assert.strictEqual(h.recorder.status, 'idle');
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(h.media_recorders.length, 0);
		assert.strictEqual(h.recorder.path, null);
	});

	test('refuses a second recording while one is under way', async () => {
		await h.recorder.start(DIR);
		assert.strictEqual(await start_error(), 'already recording');
		assert.strictEqual(h.recorder.status, 'recording', 'the first is untouched');
		assert.strictEqual(h.recorder.error, null);
		assert.strictEqual(h.streams.length, 1);
	});

	test('a start cancelled during the permission prompt closes the microphone when it opens', async () => {
		let grant!: (stream: MediaStream) => void;
		const late_stream = new FakeStream();
		h.deps.get_user_media_override = () =>
			new Promise((resolve) => {
				grant = resolve;
			});
		const started = h.recorder.start(DIR);
		assert.strictEqual(h.recorder.status, 'starting');
		assert.strictEqual(await h.recorder.stop(), null);
		assert.strictEqual(h.recorder.status, 'idle');

		grant(late_stream as unknown as MediaStream);
		await started;
		assert.ok(late_stream.track.stopped);
		assert.strictEqual(h.recorder.status, 'idle');
		assert.strictEqual(h.routes.requests.length, 0);
	});
});

describe('Recorder.pause and resume', () => {
	test('pause the browser recorder and stop the clock', async () => {
		const { recorder, clock } = h;
		await recorder.start(DIR);
		clock.now += 4000;
		recorder.pause();
		assert.strictEqual(recorder.status, 'paused');
		assert.strictEqual(h.media_recorders[0]!.state, 'paused');
		assert.ok(recorder.active, 'the microphone is still open');
		assert.ok(!h.streams[0]!.track.stopped);
		assert.strictEqual(recorder.duration, 4000);

		clock.now += 60_000; // paused time doesn't count
		recorder.resume();
		assert.strictEqual(recorder.status, 'recording');
		assert.strictEqual(h.media_recorders[0]!.state, 'recording');
		clock.now += 1500;
		recorder.pause();
		assert.strictEqual(recorder.duration, 5500);
	});

	test('do nothing in the wrong state', () => {
		h.recorder.pause();
		h.recorder.resume();
		assert.strictEqual(h.recorder.status, 'idle');
	});
});

describe('Recorder.stop', () => {
	test('uploads the last chunk, closes the microphone, and finalizes', async () => {
		const { recorder, routes, clock } = h;
		await recorder.start(DIR);
		const media_recorder = h.media_recorders[0]!;
		media_recorder.emit(100);
		media_recorder.final_chunk_size = 30;
		clock.now += 2000;

		const stopped = recorder.stop();
		assert.strictEqual(recorder.status, 'stopping');
		assert.strictEqual(await stopped, PATH);

		assert.strictEqual(routes.size_of(PATH), 130);
		assert.deepEqual(h.finalized, [{ path: PATH }]);
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(recorder.status, 'idle');
		assert.ok(!recorder.active);
		assert.strictEqual(recorder.path, null);
		assert.strictEqual(recorder.last_path, PATH);
		assert.strictEqual(recorder.error, null);
		assert.strictEqual(recorder.duration, 2000);
	});

	test('finalizes only after every chunk has landed', async () => {
		const { recorder, routes } = h;
		await recorder.start(DIR);
		// the first append gets no answer and is retried later
		routes.replies.push('network_error');
		h.media_recorders[0]!.emit(100);
		const stopped = recorder.stop();
		await flush();
		assert.deepEqual(h.finalized, [], 'still uploading');
		await stopped;
		assert.strictEqual(routes.size_of(PATH), 100);
		assert.deepEqual(h.finalized, [{ path: PATH }]);
	});

	test('works from paused', async () => {
		await h.recorder.start(DIR);
		h.recorder.pause();
		assert.strictEqual(await h.recorder.stop(), PATH);
		assert.strictEqual(h.recorder.status, 'idle');
	});

	test('keeps the recording and says so when finalizing fails', async () => {
		h.finalize_result = result_error(JSONRPC_ERROR_CODES.internal_error, 'ffmpeg not found');
		await h.recorder.start(DIR);
		h.media_recorders[0]!.emit(10);
		assert.strictEqual(await h.recorder.stop(), PATH);
		assert.include(h.recorder.error, "couldn't finalize");
		assert.include(h.recorder.error, 'ffmpeg not found');
		assert.strictEqual(h.recorder.last_path, PATH);
		assert.strictEqual(h.recorder.status, 'idle');
	});

	test('does nothing when idle', async () => {
		assert.strictEqual(await h.recorder.stop(), null);
		assert.deepEqual(h.finalized, []);
	});

	test('a track that ends stops the recording', async () => {
		await h.recorder.start(DIR);
		h.streams[0]!.track.dispatchEvent(new Event('ended'));
		await flush();
		await flush();
		assert.strictEqual(h.recorder.status, 'idle');
		assert.deepEqual(h.finalized, [{ path: PATH }]);
	});
});

describe('Recorder.level', () => {
	test('follows the meter while the microphone is open, paused included', async () => {
		vi.useFakeTimers();
		try {
			const { recorder, meters } = h;
			assert.strictEqual(recorder.level, 0);
			await recorder.start(DIR);
			assert.strictEqual(meters.length, 1);
			vi.advanceTimersByTime(RECORDER_TICK_INTERVAL);
			assert.strictEqual(recorder.level, 0.5);

			recorder.pause();
			meters[0]!.level = 0.9;
			vi.advanceTimersByTime(RECORDER_TICK_INTERVAL);
			assert.strictEqual(recorder.level, 0.9);

			const stopped = recorder.stop();
			await vi.advanceTimersByTimeAsync(RECORDER_TICK_INTERVAL);
			await stopped;
			assert.strictEqual(recorder.level, 0);
			assert.ok(meters[0]!.closed);
			// nothing ticks once the microphone is closed
			meters[0]!.level = 0.7;
			vi.advanceTimersByTime(RECORDER_TICK_INTERVAL * 3);
			assert.strictEqual(recorder.level, 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test('the duration ticks only while recording', async () => {
		vi.useFakeTimers();
		try {
			const { recorder, clock } = h;
			await recorder.start(DIR);
			clock.now += 300;
			vi.advanceTimersByTime(RECORDER_TICK_INTERVAL);
			assert.strictEqual(recorder.duration, 300);
			recorder.pause();
			clock.now += 5000;
			vi.advanceTimersByTime(RECORDER_TICK_INTERVAL);
			assert.strictEqual(recorder.duration, 300);
			await recorder.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test('a failed start closes its meter', async () => {
		h.routes.files.set(PATH, []);
		await start_error();
		assert.ok(h.meters[0]!.closed);
		assert.strictEqual(h.recorder.level, 0);
	});
});

describe('Recorder.transcribe_on_stop', () => {
	test('queues a transcription once the recording is saved, by default', async () => {
		assert.ok(h.recorder.transcribe_on_stop);
		await h.recorder.start(DIR);
		h.media_recorders[0]!.emit(10);
		assert.deepEqual(h.transcribed, [], 'not while recording');
		await h.recorder.stop();
		await flush();
		assert.deepEqual(h.finalized, [{ path: PATH }]);
		assert.deepEqual(h.transcribed, [{ path: PATH }]);
		assert.strictEqual(h.recorder.error, null);
	});

	test('does not when the toggle is off', async () => {
		h.recorder.transcribe_on_stop = false;
		await h.recorder.start(DIR);
		await h.recorder.stop();
		await flush();
		assert.deepEqual(h.transcribed, []);
	});

	test('does not for a recording whose upload failed', async () => {
		await h.recorder.start(DIR);
		h.routes.replies.push({ status: 401, body: { error: 'authentication_required' } });
		h.media_recorders[0]!.emit(10);
		await flush();
		assert.deepEqual(h.transcribed, []);
	});

	test('a backend with no speech model is not an error', async () => {
		h.transcribe_result = {
			ok: false,
			error: {
				code: JSONRPC_ERROR_CODES.service_unavailable,
				message: 'whisper-cli is not installed',
				data: { reason: 'tool_unavailable' }
			}
		};
		await h.recorder.start(DIR);
		await h.recorder.stop();
		await flush();
		assert.deepEqual(h.transcribed, [{ path: PATH }]);
		assert.strictEqual(h.recorder.error, null);
	});

	test('any other refusal is reported', async () => {
		h.transcribe_result = result_error(JSONRPC_ERROR_CODES.forbidden, 'path is not allowed');
		await h.recorder.start(DIR);
		await h.recorder.stop();
		await flush();
		assert.include(h.recorder.error, "couldn't start transcribing");
		assert.include(h.recorder.error, 'path is not allowed');
	});
});

describe('Recorder failures and teardown', () => {
	test('an upload that fails for good ends the recording and closes the microphone', async () => {
		const { recorder, routes } = h;
		await recorder.start(DIR);
		routes.replies.push({ status: 401, body: { error: 'authentication_required' } });
		h.media_recorders[0]!.emit(10);
		await flush();

		assert.strictEqual(recorder.status, 'idle');
		assert.strictEqual(recorder.error, 'upload failed: authentication_required');
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(h.media_recorders[0]!.state, 'inactive');
		assert.strictEqual(recorder.last_path, PATH);
		assert.deepEqual(h.finalized, [], 'a broken upload is not finalized');
	});

	test('a browser recorder error ends the recording', async () => {
		await h.recorder.start(DIR);
		h.media_recorders[0]!.dispatchEvent(new Event('error'));
		assert.strictEqual(h.recorder.status, 'idle');
		assert.strictEqual(h.recorder.error, 'the recorder failed');
		assert.ok(h.streams[0]!.track.stopped);
	});

	test('disposing the app closes the microphone without finalizing', async () => {
		await h.recorder.start(DIR);
		h.media_recorders[0]!.emit(10);
		h.app.dispose();
		await flush();
		assert.ok(h.streams[0]!.track.stopped);
		assert.strictEqual(h.media_recorders[0]!.state, 'inactive');
		assert.strictEqual(h.recorder.status, 'idle');
		assert.deepEqual(h.finalized, []);
	});

	test('the next start clears the last error', async () => {
		h.deps.user_active = false;
		await start_error();
		assert.ok(h.recorder.error);
		h.deps.user_active = true;
		h.clock.now += 1000;
		await h.recorder.start(DIR);
		assert.strictEqual(h.recorder.error, null);
		assert.strictEqual(h.recorder.status, 'recording');
	});
});
