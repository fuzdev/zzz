// @vitest-environment jsdom

import { FactHashSchema } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Transcript } from '#lib/transcript_types.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';
import DiskfileTranscriptView from '#lib/DiskfileTranscriptView.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * The transcript view reads its audio's metadata — the cell kept for a
 * draft or a tab, else the index's record — without holding the audio, so
 * the audio is never read as text.
 */

const DIR = '/w/rec/';
const AUDIO = parse_or_throw(DiskfilePath, `${DIR}a.webm`);
const TRANSCRIPT = `${DIR}a.webm.base.transcript.json`;

let app: Frontend;
let disk: FakeDisk;
let target: HTMLElement;
let mounted: ReturnType<typeof mount> | null;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend({ api_url: 'http://localhost:4461/api' }));
	app.zzz_dir = '/w/';
	disk = install_fake_disk(app, '/w/');
	target = document.createElement('div');
	document.body.append(target);
	mounted = null;
});
afterEach(() => {
	if (mounted) void unmount(mounted);
	target.remove();
	app.dispose();
	vi.restoreAllMocks();
});

const transcript_json = (): string =>
	JSON.stringify({
		version: 1,
		source: {
			name: 'a.webm',
			blake3: parse_or_throw(FactHashSchema, `blake3:${'ab'.repeat(32)}`),
			size: 10,
			duration_ms: 1000
		},
		tool: {
			backend: 'whisper_cpp',
			version: '1.9.4',
			model: 'base',
			model_blake3: parse_or_throw(FactHashSchema, `blake3:${'cd'.repeat(32)}`),
			params: { language: 'auto' }
		},
		language: 'en',
		segments: []
	} satisfies Transcript);

const render = async (): Promise<void> => {
	const transcript = await disk.load(TRANSCRIPT, transcript_json());
	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: DiskfileTranscriptView, props: { diskfile: transcript } }
	});
	flushSync();
};

const open_audio_button = (): HTMLButtonElement | null =>
	target.querySelector('button[title="open the audio file"]');

test('an indexed audio nothing holds plays from its record, with no cell and no read', async () => {
	app.diskfiles.upsert(disk.disknode(AUDIO));
	await render();
	await flush_reads();
	assert.ok(target.querySelector('audio'), 'the player');
	assert.ok(open_audio_button(), 'the open button');
	assert.isUndefined(app.diskfiles.peek(AUDIO), 'no cell for it');
	assert.notInclude(disk.reads, AUDIO, 'never read as text');
});

test('an audio arriving later shows its player', async () => {
	await render();
	assert.isNull(target.querySelector('audio'));
	assert.include(target.textContent, 'isn’t beside it'.replace('’', "'"));
	app.diskfiles.upsert(disk.disknode(AUDIO));
	flushSync();
	assert.ok(target.querySelector('audio'));
	assert.ok(open_audio_button());
});
