// @vitest-environment jsdom

import { test, assert, afterEach } from 'vitest';
import { allow_logged_error } from '@fuzdev/fuz_app/testing/logged_errors.ts';
import { flushSync, mount, unmount } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import ProjectRegistryEntries from '#lib/ProjectRegistryEntries.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';

const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

// the real `app.api`, whose calls write the actions state: mounting must
// start one poll, not re-run its effect on that write
test('mounting through the real api starts one quiet poll', async () => {
	allow_logged_error(
		'no transport available',
		'the test runs without a transport, so what the component sends fails'
	);
	const app = new Frontend();
	const project = app.projects.add({
		root: DEV,
		name: 'dev',
		opened_at: '2026-11-16T00:00:00.000Z',
		kind: 'registry',
		registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
		fallback: null,
		entries: [
			{
				key: 'app',
				kind: 'repo',
				dir: parse_or_throw(DiskfileDirectoryPath, '/dev/app/'),
				state: 'present'
			}
		],
		focused: [],
		ignored: {},
		rev: 1
	});
	let sends = 0;
	// settles with the first poll's send, which fails for want of a transport
	let first_sent!: (result: unknown) => void;
	const first_send = new Promise<unknown>((resolve) => (first_sent = resolve));
	const peer = app.peer as unknown as { send: (...args: Array<unknown>) => unknown };
	const send = peer.send.bind(peer);
	peer.send = (...args) => {
		const polled = (args[0] as { method?: string } | undefined)?.method === 'project_status';
		if (polled) sends++;
		const result = send(...args);
		if (polled) first_sent(result);
		return result;
	};
	const actions_before = app.actions.items.size;
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: {
			app,
			component: ProjectRegistryEntries,
			props: { project, ontoggle: () => undefined }
		}
	});
	cleanup.push(() => {
		void unmount(mounted);
		target.remove();
		app.dispose();
	});
	flushSync();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed_out = new Promise<false>((resolve) => (timer = setTimeout(resolve, 1000, false)));
	const fired = await Promise.race([first_send.then(() => true as const), timed_out]);
	clearTimeout(timer);
	assert.isTrue(fired, 'the mount starts a poll');
	flushSync();
	assert.strictEqual(sends, 1);
	assert.strictEqual(app.actions.items.size, actions_before, 'polls stay out of the actions log');
});
