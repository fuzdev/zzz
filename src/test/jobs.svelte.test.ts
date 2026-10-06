// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { DiskfilePath } from '$lib/diskfile_types.ts';
import type { JobSnapshot } from '$lib/job_types.ts';

import { result_ok } from './terminal_test_helpers.ts';

const PATH_A = DiskfilePath.parse('/w/a.webm');
const PATH_B = DiskfilePath.parse('/w/b.webm');

const create_snapshot = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
	job_id: create_uuid(),
	kind: 'transcription',
	status: 'queued',
	progress: null,
	input_path: PATH_A,
	output_path: null,
	commands: [],
	queued_at: 1000,
	started_at: null,
	ended_at: null,
	error: null,
	stderr: '',
	...overrides
});

let app: Frontend;

beforeEach(() => {
	app = new Frontend();
});

afterEach(() => {
	app.dispose();
});

describe('Jobs.receive_changed', () => {
	test('adds a job, then updates it in place', () => {
		const snapshot = create_snapshot();
		const job = app.jobs.receive_changed(snapshot);
		assert.strictEqual(app.jobs.items.size, 1);
		assert.strictEqual(job.status, 'queued');
		assert.ok(job.cancellable);
		assert.ok(!job.finished);

		const same = app.jobs.receive_changed({
			...snapshot,
			status: 'running',
			started_at: 2000,
			progress: 0.4,
			commands: ['ffmpeg -i fd:']
		});
		assert.strictEqual(same, job);
		assert.strictEqual(app.jobs.items.size, 1);
		assert.strictEqual(job.status, 'running');
		assert.strictEqual(job.progress, 0.4);
		assert.deepEqual(job.commands, ['ffmpeg -i fd:']);

		app.jobs.receive_changed({
			...snapshot,
			status: 'succeeded',
			started_at: 2000,
			ended_at: 5500,
			progress: 1,
			output_path: DiskfilePath.parse('/w/a.webm.base.en.transcript.json')
		});
		assert.ok(job.finished);
		assert.ok(!job.cancellable);
		assert.strictEqual(job.run_duration, 3500);
		assert.strictEqual(job.output_path, '/w/a.webm.base.en.transcript.json');
	});

	test('keeps the live segments across updates', () => {
		const snapshot = create_snapshot({ status: 'running' });
		const job = app.jobs.receive_changed(snapshot);
		app.jobs.receive_transcription_progress(snapshot.job_id, [
			{ start_ms: 0, end_ms: 1000, text: 'one' }
		]);
		app.jobs.receive_changed({ ...snapshot, status: 'running', progress: 0.5 });
		app.jobs.receive_transcription_progress(snapshot.job_id, [
			{ start_ms: 1000, end_ms: 2000, text: 'two' },
			{ start_ms: 2000, end_ms: 3000, text: 'three' }
		]);
		assert.deepEqual(
			job.live_segments.map((s) => s.text),
			['one', 'two', 'three']
		);
	});
});

describe('Jobs.receive_transcription_progress', () => {
	test('drops segments for a job it has not heard of', () => {
		app.jobs.receive_transcription_progress(create_uuid(), [{ start_ms: 0, end_ms: 1, text: 'x' }]);
		assert.strictEqual(app.jobs.items.size, 0);
	});
});

describe('Jobs.latest_for_input', () => {
	test('is the newest job on that file', () => {
		app.jobs.receive_changed(create_snapshot({ queued_at: 1, status: 'failed' }));
		const newest = app.jobs.receive_changed(create_snapshot({ queued_at: 3 }));
		app.jobs.receive_changed(create_snapshot({ queued_at: 2, status: 'cancelled' }));
		app.jobs.receive_changed(create_snapshot({ queued_at: 9, input_path: PATH_B }));
		assert.strictEqual(app.jobs.latest_for_input(PATH_A), newest);
		assert.strictEqual(app.jobs.latest_for_input(DiskfilePath.parse('/w/none.webm')), undefined);
	});
});

describe('Jobs lists', () => {
	test('sort newest first and pick out the unfinished', () => {
		const a = app.jobs.receive_changed(create_snapshot({ queued_at: 1, status: 'succeeded' }));
		const b = app.jobs.receive_changed(create_snapshot({ queued_at: 3, status: 'running' }));
		const c = app.jobs.receive_changed(create_snapshot({ queued_at: 2 }));
		assert.deepEqual(app.jobs.newest_first, [b, c, a]);
		assert.deepEqual(new Set(app.jobs.unfinished), new Set([b, c]));
	});
});

describe('Jobs.reconcile', () => {
	test('takes the backend list as the truth', () => {
		const kept = create_snapshot({ queued_at: 1, status: 'running' });
		const gone = create_snapshot({ queued_at: 2 });
		const kept_job = app.jobs.receive_changed(kept);
		app.jobs.receive_changed(gone);
		const added = create_snapshot({ queued_at: 3, input_path: PATH_B });

		app.jobs.reconcile([{ ...kept, status: 'succeeded', ended_at: 5 }, added]);
		assert.strictEqual(app.jobs.items.size, 2);
		assert.strictEqual(app.jobs.get_by_job_id(kept.job_id), kept_job);
		assert.strictEqual(kept_job.status, 'succeeded');
		assert.strictEqual(app.jobs.get_by_job_id(gone.job_id), undefined);
		assert.ok(app.jobs.get_by_job_id(added.job_id));
	});

	test('a restarted backend leaves none', () => {
		app.jobs.receive_changed(create_snapshot({ status: 'running' }));
		app.jobs.reconcile([]);
		assert.strictEqual(app.jobs.items.size, 0);
	});
});

describe('Jobs actions', () => {
	test('transcribe and cancel call the backend', async () => {
		const calls: Array<[string, unknown]> = [];
		const job_id: Uuid = create_uuid();
		(app as unknown as { api: unknown }).api = {
			transcription_create: (input: unknown) => {
				calls.push(['transcription_create', input]);
				return Promise.resolve(result_ok({ job_id }));
			},
			job_cancel: (input: unknown) => {
				calls.push(['job_cancel', input]);
				return Promise.resolve(result_ok(null));
			}
		};
		assert.deepEqual(await app.jobs.transcribe(PATH_A), { ok: true, value: { job_id } });
		await app.jobs.transcribe(PATH_B, 'fr');
		const job = app.jobs.receive_changed(create_snapshot({ job_id }));
		await app.jobs.cancel(job);
		assert.deepEqual(calls, [
			['transcription_create', { path: PATH_A }],
			['transcription_create', { path: PATH_B, language: 'fr' }],
			['job_cancel', { job_id }]
		]);
	});
});
