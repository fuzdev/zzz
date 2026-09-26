// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Diskfile } from '$lib/diskfile.svelte.ts';
import type { Action } from '$lib/action.svelte.ts';
import { create_detached } from '$lib/reactive_helpers.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';

import CallbackHarness from './CallbackHarness.svelte';

/**
 * A `$derived` is owned by the effect running when it's created, and stops
 * recomputing once that effect is destroyed. State that outlives a component
 * must be created detached — see `create_detached`.
 */

const SCOPES = ['oninit', 'onmount', 'oneffect'] as const;

let app: Frontend;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	app = new Frontend();
});
afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

/** Mounts a component that runs `callback` in `scope`, then unmounts it. */
const run_in_unmounted_scope = (scope: (typeof SCOPES)[number], callback: () => void): void => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(CallbackHarness, { target, props: { [scope]: callback } });
	flushSync();
	void unmount(mounted);
	target.remove();
	flushSync();
};

describe('create_detached', () => {
	for (const scope of SCOPES) {
		test(`a cell created in ${scope} stays live after the component unmounts`, () => {
			let diskfile!: Diskfile;
			run_in_unmounted_scope(scope, () => {
				diskfile = create_detached(
					() =>
						new Diskfile({
							app,
							json: {
								path: DiskfilePath.parse('/w/a.txt'),
								source_dir: SerializableDisknode.shape.source_dir.parse('/w/'),
								content: 'abc'
							}
						})
				);
				// evaluated while mounted
				assert.strictEqual(diskfile.content_length, 3);
			});

			diskfile.content = 'abcdef';

			assert.strictEqual(diskfile.content_length, 6);
		});
	}

	test('returns what the callback returns, untracked', () => {
		assert.strictEqual(
			create_detached(() => 42),
			42
		);
	});
});

describe('actions created by api calls in component scopes', () => {
	for (const scope of SCOPES) {
		test(`an api call in ${scope} leaves an action that settles after unmount`, async () => {
			let action!: Action;
			run_in_unmounted_scope(scope, () => {
				void app.api.ping();
				action = app.actions.items.values.at(-1)!;
				assert.ok(action);
				// evaluated while mounted, as the actions log would
				assert.isTrue(action.pending);
			});

			// no transport, so the request fails
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.isFalse(action.pending);
			assert.isTrue(action.has_error);
		});
	}
});
