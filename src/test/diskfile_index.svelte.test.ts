// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, assert } from 'vitest';
import { flushSync, tick } from 'svelte';

import { DiskfileIndex } from '#lib/diskfile_index.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfilePath,
	type SerializableDisknode
} from '#lib/diskfile_types.ts';
import { create_detached } from '#lib/reactive_helpers.svelte.ts';

const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
const WS = parse_or_throw(DiskfileDirectoryPath, '/ws/');
const OTHER = parse_or_throw(DiskfileDirectoryPath, '/ws/sub/');

const node = (
	path: string,
	options?: Partial<Omit<SerializableDisknode, 'id'>>
): SerializableDisknode => ({
	id: at(path),
	source_dir: WS,
	size: 1,
	ctime: 1,
	mtime: 1,
	...options
});

/** Runs `read` in an effect under its own root, recording each value. */
const watch = (read: () => unknown): { values: Array<unknown>; stop: () => void } => {
	const values: Array<unknown> = [];
	const stop = $effect.root(() => {
		$effect(() => {
			values.push(read());
		});
	});
	flushSync();
	return { values, stop };
};

/** Lets the subscriptions' teardown, deferred to a microtask, run. */
const settle_teardown = async (): Promise<void> => {
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('counters', () => {
	test('membership moves once per add or remove, meta once per change in place', () => {
		const index = new DiskfileIndex();
		index.set(node('/ws/a.ts'));
		assert.strictEqual(index.membership, 1);
		assert.strictEqual(index.meta, 0);

		index.set(node('/ws/a.ts', { mtime: 2 }));
		assert.strictEqual(index.membership, 1);
		assert.strictEqual(index.meta, 1);

		index.set(node('/ws/a.ts', { ctime: 2 }));
		index.set(node('/ws/a.ts', { ctime: 2, size: 5 }));
		assert.strictEqual(index.meta, 3, 'ctime and size each move it');

		index.delete(at('/ws/a.ts'));
		assert.strictEqual(index.membership, 2);
		assert.strictEqual(index.meta, 3);
	});

	test('a record equal to the one held moves nothing and keeps the held object', () => {
		const index = new DiskfileIndex();
		const first = node('/ws/a.ts');
		index.set(first);
		index.set(node('/ws/a.ts'));
		assert.strictEqual(index.membership, 1);
		assert.strictEqual(index.meta, 0);
		assert.strictEqual(index.get(at('/ws/a.ts')), first);
		assert.isFalse(index.delete(at('/ws/missing.ts')));
		assert.strictEqual(index.membership, 1, 'deleting a missing path moves nothing');
	});

	test('a batch moves each counter once, nested batches included', () => {
		const index = new DiskfileIndex();
		index.set(node('/ws/old.ts'));
		const before = { membership: index.membership, meta: index.meta };
		index.batch(() => {
			for (let i = 0; i < 50; i++) index.set(node(`/ws/f${i}.ts`));
			index.batch(() => {
				index.set(node('/ws/old.ts', { size: 9 }));
				index.delete(at('/ws/f0.ts'));
			});
			assert.strictEqual(index.membership, before.membership, 'not until the outermost ends');
		});
		assert.strictEqual(index.membership, before.membership + 1);
		assert.strictEqual(index.meta, before.meta + 1);
	});

	test('a batch that changes nothing moves nothing', () => {
		const index = new DiskfileIndex();
		index.set(node('/ws/a.ts'));
		index.batch(() => index.set(node('/ws/a.ts')));
		assert.strictEqual(index.membership, 1);
		assert.strictEqual(index.meta, 0);
	});

	test('a batch that throws still moves the counters for what it wrote', () => {
		const index = new DiskfileIndex();
		assert.throws(() =>
			index.batch(() => {
				index.set(node('/ws/a.ts'));
				throw new Error('boom');
			})
		);
		assert.strictEqual(index.membership, 1);
		assert.isTrue(index.has('/ws/a.ts'));
	});

	test('an effect reading `size` reruns once per batch', () => {
		const index = new DiskfileIndex();
		const w = watch(() => index.size);
		index.batch(() => {
			for (let i = 0; i < 10; i++) index.set(node(`/ws/f${i}.ts`));
		});
		flushSync();
		index.set(node('/ws/f0.ts', { mtime: 5 }));
		flushSync();
		assert.deepEqual(w.values, [0, 10], 'a change in place leaves `size` alone');
		w.stop();
	});
});

describe('per-path watches', () => {
	test('a reader of one path reruns only for writes to it', () => {
		const index = new DiskfileIndex();
		const x = watch(() => index.get(at('/ws/x.ts'))?.mtime ?? null);
		const has_x = watch(() => index.has('/ws/x.ts'));
		index.set(node('/ws/y.ts'));
		flushSync();
		index.set(node('/ws/x.ts'));
		flushSync();
		index.set(node('/ws/y.ts', { mtime: 3 }));
		flushSync();
		index.set(node('/ws/x.ts', { mtime: 2 }));
		flushSync();
		index.set(node('/ws/x.ts', { mtime: 2 }));
		flushSync();
		index.delete(at('/ws/y.ts'));
		flushSync();
		index.delete(at('/ws/x.ts'));
		flushSync();
		assert.deepEqual(x.values, [null, 1, 2, null]);
		assert.deepEqual(has_x.values, [false, true, true, false]);
		x.stop();
		has_x.stop();
	});

	test('a write to a path no reader holds makes no watch', () => {
		const index = new DiskfileIndex();
		index.set(node('/ws/a.ts'));
		index.get(at('/ws/a.ts'));
		index.has('/ws/b.ts');
		assert.strictEqual(index.watch_count, 0);
	});

	test('no watch is left once its effects are destroyed', async () => {
		const index = new DiskfileIndex();
		const a1 = watch(() => index.has('/ws/a.ts'));
		const a2 = watch(() => index.get(at('/ws/a.ts')));
		const b = watch(() => index.has('/ws/b.ts'));
		assert.strictEqual(index.watch_count, 2, 'one per path');
		a1.stop();
		await settle_teardown();
		assert.strictEqual(index.watch_count, 2, 'a path keeps its watch while any reader holds it');
		index.set(node('/ws/a.ts'));
		flushSync();
		assert.strictEqual(a2.values.length, 2, 'the remaining reader is still notified');
		a2.stop();
		b.stop();
		await settle_teardown();
		assert.strictEqual(index.watch_count, 0);
	});

	test('a path watched again after its watch was dropped is notified', async () => {
		const index = new DiskfileIndex();
		watch(() => index.has('/ws/a.ts')).stop();
		await settle_teardown();
		assert.strictEqual(index.watch_count, 0);
		const again = watch(() => index.has('/ws/a.ts'));
		index.set(node('/ws/a.ts'));
		flushSync();
		assert.deepEqual(again.values, [false, true]);
		again.stop();
		await settle_teardown();
		assert.strictEqual(index.watch_count, 0);
	});

	test('a `$derived` read outside any effect keeps at most one watch for its path', async () => {
		const index = new DiskfileIndex();
		const holder = create_detached(() => new PathHolder(index, at('/ws/a.ts')));
		const plain = create_detached(() => new PathHolder(index, at('/ws/b.ts')));
		assert.isFalse(holder.exists);
		for (let i = 0; i < 5; i++) {
			index.set(node('/ws/a.ts', { mtime: i }));
			assert.isTrue(holder.exists, 'it reads current values');
			index.delete(at('/ws/a.ts'));
			assert.isFalse(holder.exists);
		}
		await settle_teardown();
		// the derived owns the subscription its last run made, until it runs again or is collected
		assert.strictEqual(index.watch_count, 1, 'repeated reads reuse the one watch');

		const w = watch(() => plain.exists);
		index.set(node('/ws/b.ts'));
		flushSync();
		assert.deepEqual(w.values, [false, true]);
		w.stop();
		await settle_teardown();
		assert.strictEqual(index.watch_count, 1, "the effect's watch is gone");
	});
});

/** A cell-like class whose `$derived` reads one path, as a part's would. */
class PathHolder {
	readonly index: DiskfileIndex;
	readonly path: DiskfilePath;
	readonly exists: boolean = $derived.by(() => this.index.has(this.path));
	constructor(index: DiskfileIndex, path: DiskfilePath) {
		this.index = index;
		this.path = path;
	}
}

describe('folders', () => {
	test('directory counts and the tree follow adds, removes, and root changes', () => {
		const index = new DiskfileIndex();
		index.set(node('/ws/sub/a.ts'));
		index.set(node('/ws/sub/b.ts'));
		assert.sameMembers([...index.directory_paths], ['/ws/', '/ws/sub/']);
		assert.strictEqual(index.tree_index.count_files_below('/ws/'), 2);

		// reported by a nested root's filer: counted only up to that root
		index.set(node('/ws/sub/a.ts', { source_dir: OTHER }));
		index.delete(at('/ws/sub/b.ts'));
		assert.sameMembers([...index.directory_paths], ['/ws/sub/']);
		assert.strictEqual(index.tree_index.count_files_below('/ws/'), 1, 'the tree links up to `/`');

		index.delete(at('/ws/sub/a.ts'));
		assert.strictEqual(index.directory_paths.size, 0);
		assert.strictEqual(index.tree_index.count_files_below('/ws/'), 0);
	});
});

describe('snapshots', () => {
	/** Applies a snapshot of `root` as `Diskfiles.reconcile` does: replace what's listed, prune the rest. */
	const apply_snapshot = (
		index: DiskfileIndex,
		files: Array<SerializableDisknode>,
		root: string
	): void => {
		index.batch(() => {
			const listed: Set<string> = new Set();
			for (const file of files) {
				index.set(file);
				listed.add(file.id);
			}
			for (const record of [...index.values()]) {
				if (record.id.startsWith(root) && !listed.has(record.id)) index.delete(record.id);
			}
		});
	};

	test('a snapshot replaces changed records with the new objects, prunes the unlisted, and keeps the rest', () => {
		const index = new DiskfileIndex();
		const kept = node('/ws/kept.ts');
		const outside = node('/elsewhere/x.ts', {
			source_dir: parse_or_throw(DiskfileDirectoryPath, '/elsewhere/')
		});
		apply_snapshot(index, [kept, node('/ws/changed.ts'), node('/ws/gone.ts')], '/ws/');
		index.set(outside);
		const before = { membership: index.membership, meta: index.meta };

		const changed = node('/ws/changed.ts', { size: 7 });
		const added = node('/ws/added.ts');
		apply_snapshot(index, [node('/ws/kept.ts'), changed, added], '/ws/');

		assert.strictEqual(index.get(at('/ws/kept.ts')), kept, 'an unchanged record is kept');
		assert.strictEqual(
			index.get(at('/ws/changed.ts')),
			changed,
			'a changed one is replaced as given'
		);
		assert.strictEqual(index.get(at('/ws/added.ts')), added);
		assert.isFalse(index.has('/ws/gone.ts'));
		assert.strictEqual(index.get(at('/elsewhere/x.ts')), outside, 'outside the root is untouched');
		assert.strictEqual(index.size, 4);
		assert.strictEqual(index.membership, before.membership + 1, 'one move for the snapshot');
		assert.strictEqual(index.meta, before.meta + 1);
	});

	test('the same snapshot again moves nothing', () => {
		const index = new DiskfileIndex();
		const files = [node('/ws/a.ts'), node('/ws/b/c.ts')];
		apply_snapshot(index, files, '/ws/');
		const before = { membership: index.membership, meta: index.meta };
		apply_snapshot(
			index,
			files.map((file) => ({ ...file })),
			'/ws/'
		);
		assert.deepEqual({ membership: index.membership, meta: index.meta }, before);
	});
});
