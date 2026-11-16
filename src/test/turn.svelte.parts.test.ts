// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '#lib/frontend.svelte.ts';
import { Thread } from '#lib/thread.svelte.ts';
import { Turn } from '#lib/turn.svelte.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

let app: Frontend;
let signals: Array<AbortSignal | undefined>;
let thread: Thread;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	signals = [];
	// a `completion_create` that stays in flight until aborted
	(app as unknown as { api: unknown }).api = {
		completion_create: (_input: unknown, options?: { signal?: AbortSignal }) =>
			new Promise<void>((resolve) => {
				signals.push(options?.signal);
				options?.signal?.addEventListener('abort', () => resolve());
			})
	};
	thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
});

describe('Turn.remove_part', () => {
	test('removes the part id and the part from `app.parts`', () => {
		const turn = thread.add_user_turn('hello');
		const [part_id] = turn.part_ids;

		assert.ok(turn.remove_part(part_id!));

		assert.deepEqual(turn.part_ids, []);
		assert.ok(!app.parts.items.has(part_id!));
	});

	test('keeps a part another turn still references', () => {
		const turn = thread.add_user_turn('hello');
		const part = turn.parts[0]!;
		const other = new Turn({ app, json: { role: 'user', part_ids: [part.id] } });
		thread.add_turn(other);

		turn.remove_part(part.id);

		assert.ok(app.parts.items.has(part.id));
		assert.deepEqual(other.parts, [part]);
	});

	test('returns false for a part the turn lacks', () => {
		const turn = thread.add_user_turn('hello');
		const other = thread.add_user_turn('other');
		const [other_part_id] = other.part_ids;

		assert.ok(!turn.remove_part(other_part_id!));
		assert.ok(app.parts.items.has(other_part_id!));
	});

	test('removing the completion part of a pending turn cancels its completion', async () => {
		const sent = thread.send_message('hi');
		const turns = Array.from(thread.turns.by_id.values());
		const user_turn = turns.at(-2)!;
		const assistant_turn = turns.at(-1)!;

		// a user turn's part isn't streamed into
		user_turn.remove_part(user_turn.part_ids[0]!);
		assert.ok(thread.pending);
		assert.ok(!signals[0]!.aborted);

		assert.ok(assistant_turn.remove_part(assistant_turn.completion_part!.id));

		assert.ok(!thread.pending);
		assert.ok(assistant_turn.cancelled);
		assert.ok(signals[0]!.aborted);
		assert.strictEqual(await sent, assistant_turn);
	});

	test('removing the completion part of an idle assistant turn leaves it unstopped', () => {
		const turn = thread.add_assistant_turn('');
		assert.ok(!turn.settled);

		assert.ok(turn.remove_part(turn.completion_part!.id));

		assert.ok(!turn.cancelled);
	});

	test('removing an idle turn completion part leaves another pending turn streaming', () => {
		const idle_turn = thread.add_assistant_turn('');
		void thread.send_message('hi');

		idle_turn.remove_part(idle_turn.completion_part!.id);

		assert.ok(!idle_turn.cancelled);
		assert.ok(thread.pending);
		assert.ok(!signals[0]!.aborted);
		thread.cancel_pending();
	});
});

describe('Turn.content', () => {
	let disk: FakeDisk;
	beforeEach(() => {
		app.zzz_dir = '/w/'; // inside the app dir, a path shows relative, as `src/big.txt`
		disk = install_fake_disk(app, '/w/');
	});

	const add_turn = (...paths: Array<string>): Turn => {
		const part_ids = [
			app.parts.add({ type: 'text', content: 'look' }).id,
			...paths.map((path) => app.parts.add({ type: 'diskfile', path }).id)
		];
		const turn = new Turn({ app, json: { role: 'user', part_ids } });
		thread.add_turn(turn);
		return turn;
	};

	test('marks a file part that can not load with its path and why', async () => {
		disk.write('/w/src/big.txt', 'x');
		disk.write('/w/bin.dat', null); // read as not UTF-8
		disk.write('/w/denied.txt', 'x');
		disk.fail_reads(1, 'permission denied'); // the first read, `denied.txt`'s
		const turn = add_turn('/w/denied.txt', '/w/bin.dat', '/w/src/big.txt');
		const big = app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/w/src/big.txt'))!;
		await flush_reads(); // the reads as the parts attach — `load_content` would retry the failed one
		// as a read of a file over 4 MiB answers
		big.content = null;
		big.unloaded_status = 'unloadable';
		big.unloaded_reason = 'too_large';
		assert.strictEqual(
			turn.content,
			[
				'look',
				'[denied.txt: content not loaded — permission denied]',
				"[bin.dat: content not loaded — the file isn't UTF-8 text]",
				'[src/big.txt: content not loaded — the file is over 4 MiB]'
			].join('\n\n')
		);
		assert.strictEqual(turn.length, turn.content.length);
	});

	test('a part still loading or with no file contributes nothing, as before', async () => {
		disk.write('/w/a.txt', 'text');
		const release = disk.hold_reads();
		const turn = add_turn('/w/a.txt', '/w/missing.txt');
		assert.ok(turn.content_loading);
		assert.strictEqual(turn.content, 'look');
		release();
		await flush_reads();
	});

	test('a copy reads a failed file once more, copying its text when that succeeds', async () => {
		disk.write('/w/a.txt', 'text');
		disk.fail_reads(1, 'connection lost');
		const turn = add_turn('/w/a.txt');
		await flush_reads();
		assert.isFalse(turn.content_loading);
		assert.isTrue(turn.content_pending_read, 'so the copy entry loads on click');
		assert.strictEqual(turn.content, 'look\n\n[a.txt: content not loaded — connection lost]');
		disk.reads.length = 0;

		assert.strictEqual(await turn.load_content(), 'look\n\ntext');
		assert.deepEqual(disk.reads, ['/w/a.txt']);
		assert.isFalse(turn.content_pending_read);
	});

	test('a copy reads a failed file once more, copying its marker when that fails', async () => {
		disk.write('/w/a.txt', 'text');
		disk.fail_reads(2, 'permission denied');
		const turn = add_turn('/w/a.txt');
		await flush_reads();
		disk.reads.length = 0;

		assert.strictEqual(
			await turn.load_content(),
			'look\n\n[a.txt: content not loaded — permission denied]'
		);
		assert.deepEqual(disk.reads, ['/w/a.txt'], 'exactly one retry');
	});

	test('a part removed while the others load is not retried', async () => {
		disk.write('/w/a.txt', 'text');
		disk.write('/w/b.txt', 'b');
		disk.fail_reads(1);
		const turn = add_turn('/w/b.txt');
		await flush_reads();
		const failed = turn.parts[1]!;
		assert(failed.type === 'diskfile');
		assert.strictEqual(failed.content_status, 'unloadable');
		const release = disk.hold_reads();
		turn.part_ids.push(app.parts.add({ type: 'diskfile', path: '/w/a.txt' }).id);
		disk.reads.length = 0;

		const loading = turn.load_content();
		turn.remove_part(failed.id);
		release();
		assert.strictEqual(await loading, 'look\n\ntext');
		assert.notInclude(disk.reads, '/w/b.txt', 'the removed part’s file isn’t read again');
	});

	test("a thread's copy retries its turns' failed reads too", async () => {
		disk.write('/w/a.txt', 'text');
		disk.fail_reads(1);
		add_turn('/w/a.txt');
		await flush_reads();
		assert.isTrue(thread.content_pending_read);
		disk.reads.length = 0;
		assert.include(await thread.load_content(), 'look\n\ntext');
		assert.deepEqual(disk.reads, ['/w/a.txt']);
	});

	test('what a copy loads holds the marker once the read says the file can not load', async () => {
		disk.write('/w/bin.dat', null);
		const release = disk.hold_reads();
		const turn = add_turn('/w/bin.dat');
		assert.ok(turn.content_loading, 'so the copy entry loads it on click');
		const loading = turn.load_content();
		release();
		assert.strictEqual(
			await loading,
			"look\n\n[bin.dat: content not loaded — the file isn't UTF-8 text]"
		);
	});
});
