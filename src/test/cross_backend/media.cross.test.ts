/**
 * Cross-backend integration tests for the media actions (`media_finalize`,
 * `transcription_create`) and the jobs they start (`job_cancel`,
 * `job_changed`, `transcription_progress`, the jobs in `session_load`).
 *
 * They run the daemon's real tools, so every test that needs one is skipped
 * — visibly — on a machine without it: `ffmpeg` on `PATH`, and for
 * transcription whisper.cpp (`whisper-cli` on `PATH` or `ZZZ_WHISPER_CPP_BIN`)
 * plus a model (`ZZZ_WHISPER_CPP_MODEL`) in the environment the tests run in,
 * which the daemon under test inherits. Responses and notifications are also
 * checked against their specs' schemas.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { blake3_ready, hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import {
	job_cancel_action_spec,
	job_changed_action_spec,
	media_finalize_action_spec,
	MediaFinalizeOutput,
	session_load_action_spec,
	transcription_create_action_spec,
	transcription_progress_action_spec
} from '$lib/action_specs.ts';
import { is_job_finished, type JobSnapshot } from '$lib/job_types.ts';
import { Transcript, TRANSCRIPT_SIDECAR_SUFFIX } from '$lib/transcript_types.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
type CrossFixture = Awaited<ReturnType<typeof setup_test>>;

const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;
const zzz_dir = handle.config.env.PUBLIC_ZZZ_DIR!;

const FFMPEG_QUIET = ['-nostdin', '-hide_banner', '-loglevel', 'error'];

/** Whether `program` runs here — the daemon under test shares this `PATH`. */
const has_program = (program: string): boolean => {
	try {
		execFileSync(program, ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const has_ffmpeg = has_program('ffmpeg');
const has_ffprobe = has_program('ffprobe');
/** Whether the daemon under test can transcribe: `ffmpeg`, whisper.cpp, and a model. */
const has_transcription =
	has_ffmpeg &&
	!!process.env.ZZZ_WHISPER_CPP_MODEL &&
	(!!process.env.ZZZ_WHISPER_CPP_BIN || has_program('whisper-cli'));

/**
 * One second of Opus in a `.webm`, muxed to a pipe the way a browser's
 * `MediaRecorder` streams its output: no duration and no seek index.
 */
const streamed_webm = (): Buffer =>
	execFileSync(
		'ffmpeg',
		[
			...FFMPEG_QUIET,
			...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
			...['-c:a', 'libopus', '-f', 'webm', 'pipe:1']
		],
		{ maxBuffer: 16 * 1024 * 1024 }
	);

/**
 * `seconds` of a quiet tone as Opus in a `.webm` — audio a transcription
 * decodes and runs over, whatever it makes of it.
 */
const tone_webm = (seconds: number): Buffer =>
	execFileSync(
		'ffmpeg',
		[
			...FFMPEG_QUIET,
			...['-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`],
			...['-c:a', 'libopus', '-b:a', '16k', '-f', 'webm', 'pipe:1']
		],
		{ maxBuffer: 64 * 1024 * 1024 }
	);

/** The duration in a file's header, in seconds — `null` when it has none. */
const header_duration = (path: string): number | null => {
	const printed = execFileSync(
		'ffprobe',
		['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
		{ encoding: 'utf-8' }
	).trim();
	const duration = Number.parseFloat(printed);
	return Number.isFinite(duration) ? duration : null;
};

const new_path = async (name: string): Promise<string> => {
	await mkdir(scoped_dir, { recursive: true });
	return join(scoped_dir, `${randomUUID()}_${name}`);
};

const finalize = (fixture: CrossFixture, path: string): ReturnType<typeof rpc_call> =>
	rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method: media_finalize_action_spec.method,
		params: { path },
		headers: fixture.create_session_headers()
	});

describe('media cross-backend', () => {
	test.skipIf(!has_ffmpeg)('media_finalize gives a streamed recording its duration', async () => {
		const fixture = await setup_test();
		const path = await new_path('recording.webm');
		const streamed = streamed_webm();
		await writeFile(path, streamed);
		await chmod(path, 0o640);
		try {
			if (has_ffprobe) assert.equal(header_duration(path), null, 'streamed: no duration');

			const res = await finalize(fixture, path);
			assert.ok(res.ok, JSON.stringify(res));
			const output = MediaFinalizeOutput.parse(res.result);
			const after = await stat(path);
			assert.equal(output.size, after.size);
			// replaced like a save: same name, same mode, new content
			assert.equal(after.mode & 0o777, 0o640);
			assert.notDeepEqual(await readFile(path), streamed);
			if (has_ffprobe) {
				const duration = header_duration(path);
				assert.ok(duration !== null && duration > 0.9 && duration < 1.2, String(duration));
			}

			// finalizing again is harmless
			const again = await finalize(fixture, path);
			assert.ok(again.ok, JSON.stringify(again));
			if (has_ffprobe) assert.ok(header_duration(path) !== null);
		} finally {
			await rm(path, { force: true });
		}
	});

	test.skipIf(!has_ffmpeg)('media_finalize refuses what is not media, untouched', async () => {
		const fixture = await setup_test();
		const real = await new_path('real.webm');
		await writeFile(real, streamed_webm());
		const cases: Array<[name: string, content: string]> = [
			['text.webm', 'just some text\n'],
			// a concat script: an unconfined ffmpeg would open the file it names
			['script.webm', `ffconcat version 1.0\nfile '${real}'\n`],
			['playlist.webm', `#EXTM3U\n#EXTINF:1,\n${real}\n#EXT-X-ENDLIST\n`]
		];
		try {
			for (const [name, content] of cases) {
				const path = await new_path(name);
				await writeFile(path, content);
				try {
					const res = await finalize(fixture, path);
					assert.ok(!res.ok, name);
					assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params, name);
					const data = res.error.data as { reason: string; stderr: string };
					assert.equal(data.reason, 'media_invalid', name);
					assert.equal(typeof data.stderr, 'string', name);
					assert.equal(await readFile(path, 'utf-8'), content, `${name} untouched`);
				} finally {
					await rm(path, { force: true });
				}
			}
		} finally {
			await rm(real, { force: true });
		}
	});

	test('media_finalize refuses paths and types it must not touch', async () => {
		const fixture = await setup_test();
		const outside_dir = await mkdtemp(join(tmpdir(), 'zzz_media_outside_'));
		const outside = join(outside_dir, 'clip.webm');
		await writeFile(outside, 'outside');
		const unsupported = await new_path('notes.txt');
		await writeFile(unsupported, 'notes');
		const expect = async (path: string, code: number, reason: string): Promise<void> => {
			const res = await finalize(fixture, path);
			assert.ok(!res.ok, path);
			assert.equal(res.error.code, code, path);
			assert.deepEqual(res.error.data, { reason }, path);
		};
		try {
			// the extension is checked before the file is opened
			await expect(unsupported, JSONRPC_ERROR_CODES.invalid_params, 'unsupported_media_type');
			await expect(
				await new_path('list.m3u8'),
				JSONRPC_ERROR_CODES.invalid_params,
				'unsupported_media_type'
			);
			await expect('relative/clip.webm', JSONRPC_ERROR_CODES.invalid_params, 'invalid_path');
			if (has_ffmpeg) {
				await expect(outside, JSONRPC_ERROR_CODES.forbidden, 'path_not_allowed');
				await expect(
					await new_path('missing.webm'),
					JSONRPC_ERROR_CODES.not_found,
					'path_not_found'
				);
			}
			assert.equal(await readFile(outside, 'utf-8'), 'outside');
		} finally {
			await rm(outside_dir, { recursive: true, force: true });
			await rm(unsupported, { force: true });
		}
	});

	test('media_finalize requires authentication', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.fresh_transport(),
			path: handle.config.rpc_path,
			method: media_finalize_action_spec.method,
			params: { path: await new_path('anonymous.webm') }
		});
		assert.ok(!res.ok);
		assert.equal(res.error.code, JSONRPC_ERROR_CODES.unauthenticated);
	});
});

type WsClient = Awaited<ReturnType<typeof create_ws_transport>>;

const open_ws = (fixture: CrossFixture): Promise<WsClient> =>
	create_ws_transport({
		base_url: handle.config.base_url,
		ws_path: handle.config.ws_path,
		cookies: fixture.transport.cookies()
	});

const transcribe = (
	fixture: CrossFixture,
	params: Record<string, unknown>
): ReturnType<typeof rpc_call> =>
	rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method: transcription_create_action_spec.method,
		params,
		headers: fixture.create_session_headers()
	});

const cancel_job = (fixture: CrossFixture, job_id: string): ReturnType<typeof rpc_call> =>
	rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method: job_cancel_action_spec.method,
		params: { job_id },
		headers: fixture.create_session_headers()
	});

/**
 * Waits for a `job_changed` for `job_id` that `where` accepts, checking it
 * against the notification's schema.
 */
const wait_for_job = async (
	ws: WsClient,
	job_id: string,
	where: (job: JobSnapshot) => boolean,
	timeout_ms = 120_000
): Promise<JobSnapshot> => {
	const message = await ws.wait_for<{ params: unknown }>((m) => {
		const candidate = m as { method?: string; params?: { job?: JobSnapshot } } | null;
		const job = candidate?.params?.job;
		return (
			candidate?.method === job_changed_action_spec.method && job?.job_id === job_id && where(job)
		);
	}, timeout_ms);
	return job_changed_action_spec.input.parse(message.params).job;
};

const expect_error = async (
	result: ReturnType<typeof rpc_call>,
	code: number,
	reason: string,
	label: string
): Promise<void> => {
	const res = await result;
	assert.ok(!res.ok, label);
	assert.equal(res.error.code, code, label);
	assert.equal((res.error.data as { reason?: string } | undefined)?.reason, reason, label);
};

describe('transcription cross-backend', () => {
	test('transcription_create refuses what it can tell up front', async () => {
		const fixture = await setup_test();
		const notes = await new_path('notes.txt');
		await writeFile(notes, 'notes');
		try {
			// each is refused before any tool is looked for or any job exists
			await expect_error(
				transcribe(fixture, { path: notes }),
				JSONRPC_ERROR_CODES.invalid_params,
				'unsupported_media_type',
				'a text file'
			);
			await expect_error(
				transcribe(fixture, { path: 'relative/clip.webm' }),
				JSONRPC_ERROR_CODES.invalid_params,
				'invalid_path',
				'a relative path'
			);
			for (const language of ['english', 'EN', '-l', '']) {
				await expect_error(
					transcribe(fixture, { path: await new_path('clip.webm'), language }),
					JSONRPC_ERROR_CODES.invalid_params,
					'invalid_language',
					`language ${JSON.stringify(language)}`
				);
			}
			const unknown_key = await transcribe(fixture, { path: notes, model: 'x' });
			assert.ok(!unknown_key.ok);
			assert.equal(unknown_key.error.code, JSONRPC_ERROR_CODES.invalid_params);

			const session = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: session_load_action_spec.method,
				headers: fixture.create_session_headers()
			});
			assert.ok(session.ok);
			assert.deepEqual(session_load_action_spec.output.parse(session.result).data.jobs, []);
		} finally {
			await rm(notes, { force: true });
		}
	});

	// on a machine with no speech model set up, transcription says so
	test.skipIf(has_transcription)('transcription_create needs the tools', async () => {
		const fixture = await setup_test();
		await expect_error(
			transcribe(fixture, { path: await new_path('clip.webm') }),
			JSONRPC_ERROR_CODES.service_unavailable,
			'tool_unavailable',
			'no tools'
		);
	});

	test.skipIf(!has_transcription)('transcribes an audio file to a sidecar', async () => {
		const fixture = await setup_test();
		await blake3_ready;
		const path = await new_path('clip.webm');
		const audio = tone_webm(2);
		await writeFile(path, audio);
		const ws = await open_ws(fixture);
		let sidecar_path: string | undefined;
		try {
			await ws.request('_warmup', 'ping', undefined);
			const created = await transcribe(fixture, { path });
			assert.ok(created.ok, JSON.stringify(created));
			const { job_id } = transcription_create_action_spec.output.parse(created.result);

			const done = await wait_for_job(ws, job_id, (job) => is_job_finished(job.status));
			assert.equal(done.status, 'succeeded', `${done.error} ${done.stderr}`);
			assert.equal(done.kind, 'transcription');
			assert.equal(done.input_path, path);
			assert.equal(done.progress, 1);
			assert.ok(done.started_at !== null && done.ended_at !== null);
			sidecar_path = done.output_path!;
			assert.ok(sidecar_path.startsWith(`${path}.`), sidecar_path);
			assert.ok(sidecar_path.endsWith(TRANSCRIPT_SIDECAR_SUFFIX), sidecar_path);

			// the tools were never handed the file's path: they read handles
			assert.equal(done.commands.length, 2, done.commands.join('\n'));
			assert.match(done.commands[0]!, /^ffmpeg .*-protocol_whitelist fd .*-i fd: /);
			assert.match(done.commands[1]!, /^whisper-cli .* -f - /);
			for (const command of done.commands) {
				assert.ok(!command.includes(path), command);
			}

			const transcript = Transcript.parse(JSON.parse(await readFile(sidecar_path, 'utf-8')));
			assert.equal(transcript.version, 1);
			assert.equal(transcript.source.name, path.slice(path.lastIndexOf('/') + 1));
			assert.equal(transcript.source.size, audio.length);
			assert.equal(transcript.source.blake3, `blake3:${hash_blake3(audio)}`);
			assert.ok(
				transcript.source.duration_ms > 1800 && transcript.source.duration_ms < 2300,
				String(transcript.source.duration_ms)
			);
			assert.equal(transcript.tool.backend, 'whisper_cpp');
			assert.match(transcript.tool.model_blake3, /^blake3:[0-9a-f]{64}$/);
			assert.equal(transcript.tool.params.language, 'auto');
			assert.ok(sidecar_path.endsWith(`.${transcript.tool.model}${TRANSCRIPT_SIDECAR_SUFFIX}`));
			// any segments a preview announced match the notification's schema
			for (const message of ws.messages as Array<{ method?: string; params?: unknown }>) {
				if (message.method === transcription_progress_action_spec.method) {
					transcription_progress_action_spec.input.parse(message.params);
				}
			}

			// nothing is left in the scratch directory
			assert.deepEqual(await readdir(join(zzz_dir, 'cache')), []);

			// the job is in the session snapshot, for a reload
			const session = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: session_load_action_spec.method,
				headers: fixture.create_session_headers()
			});
			assert.ok(session.ok);
			const { jobs } = session_load_action_spec.output.parse(session.result).data;
			assert.deepEqual(
				jobs.map((job) => [job.job_id, job.status]),
				[[job_id, 'succeeded']]
			);

			// a transcript is written once
			await expect_error(
				transcribe(fixture, { path }),
				JSONRPC_ERROR_CODES.conflict,
				'already_exists',
				'a second transcription'
			);
		} finally {
			await ws.close();
			await rm(path, { force: true });
			if (sidecar_path) await rm(sidecar_path, { force: true });
		}
	});

	test.skipIf(!has_transcription)('a file that is not audio fails the job, with why', async () => {
		const fixture = await setup_test();
		const path = await new_path('text.webm');
		await writeFile(path, 'just some text\n');
		const ws = await open_ws(fixture);
		try {
			await ws.request('_warmup', 'ping', undefined);
			const created = await transcribe(fixture, { path });
			assert.ok(created.ok, JSON.stringify(created));
			const { job_id } = transcription_create_action_spec.output.parse(created.result);
			const done = await wait_for_job(ws, job_id, (job) => is_job_finished(job.status));
			assert.equal(done.status, 'failed');
			assert.include(done.error, 'failed to decode the audio');
			assert.ok(done.stderr.length > 0);
			assert.equal(done.output_path, null);
			assert.deepEqual(
				(await readdir(scoped_dir)).filter((name) => name.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)),
				[]
			);
		} finally {
			await ws.close();
			await rm(path, { force: true });
		}
	});

	test.skipIf(!has_transcription)('jobs queue, and cancel whether queued or running', async () => {
		const fixture = await setup_test();
		// long enough that the first is still running when the second is cancelled
		const first_path = await new_path('long.webm');
		const second_path = await new_path('queued.webm');
		await writeFile(first_path, tone_webm(1800));
		await writeFile(second_path, tone_webm(2));
		const ws = await open_ws(fixture);
		try {
			await ws.request('_warmup', 'ping', undefined);
			const first = await transcribe(fixture, { path: first_path });
			const second = await transcribe(fixture, { path: second_path });
			assert.ok(first.ok && second.ok, JSON.stringify([first, second]));
			const first_id = transcription_create_action_spec.output.parse(first.result).job_id;
			const second_id = transcription_create_action_spec.output.parse(second.result).job_id;

			await wait_for_job(ws, first_id, (job) => job.status === 'running');

			// the queued one never starts
			const cancelled_queued = await cancel_job(fixture, second_id);
			assert.ok(cancelled_queued.ok, JSON.stringify(cancelled_queued));
			job_cancel_action_spec.output.parse(cancelled_queued.result);
			const second_done = await wait_for_job(ws, second_id, (job) => job.status === 'cancelled');
			assert.equal(second_done.started_at, null);

			// the running one is stopped
			assert.ok((await cancel_job(fixture, first_id)).ok);
			const first_done = await wait_for_job(ws, first_id, (job) => is_job_finished(job.status));
			assert.equal(first_done.status, 'cancelled');
			assert.equal(first_done.output_path, null);

			// cancelling a job that's over is fine, and changes nothing
			assert.ok((await cancel_job(fixture, first_id)).ok);
			assert.deepEqual(
				(await readdir(scoped_dir)).filter((name) => name.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)),
				[]
			);
			// the cancelled run's scratch is gone too
			assert.deepEqual(await readdir(join(zzz_dir, 'cache')), []);

			// another account can neither see nor cancel them
			const other = await fixture.create_account({ username: 'job_stranger' });
			const stranger_cancel = await rpc_call({
				app: fixture.fresh_transport(),
				path: handle.config.rpc_path,
				method: job_cancel_action_spec.method,
				params: { job_id: first_id },
				headers: other.create_session_headers()
			});
			assert.ok(!stranger_cancel.ok);
			assert.equal(stranger_cancel.error.code, JSONRPC_ERROR_CODES.not_found);
			const stranger_session = await rpc_call({
				app: fixture.fresh_transport(),
				path: handle.config.rpc_path,
				method: session_load_action_spec.method,
				headers: other.create_session_headers()
			});
			assert.ok(stranger_session.ok);
			assert.deepEqual(
				session_load_action_spec.output.parse(stranger_session.result).data.jobs,
				[]
			);
		} finally {
			await ws.close();
			await rm(first_path, { force: true });
			await rm(second_path, { force: true });
		}
	});

	test('job_cancel of an unknown job is not found', async () => {
		const fixture = await setup_test();
		await expect_error(
			cancel_job(fixture, create_uuid()),
			JSONRPC_ERROR_CODES.not_found,
			'job_not_found',
			'an unknown id'
		);
		const malformed = await cancel_job(fixture, 'not-a-uuid');
		assert.ok(!malformed.ok);
		assert.equal(malformed.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});
});
