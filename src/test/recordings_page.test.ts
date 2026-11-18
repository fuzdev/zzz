// @vitest-environment jsdom

import { FactHashSchema } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Transcript } from '#lib/transcript_types.ts';
import RecordingsPage from '#routes/recordings/+page.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
// the footer reads the site context, which isn't the page's concern here
vi.mock('#routes/PageFooter.svelte', () => ({ default: () => undefined }));

const RECORDINGS = '/w/recordings/';

let app: Frontend;
let disk: FakeDisk;
let target: HTMLElement;
let mounted: ReturnType<typeof mount> | null;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
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

const create_transcript = (model: string): Transcript => ({
	version: 2,
	source: {
		blake3: parse_or_throw(FactHashSchema, `blake3:${'ab'.repeat(32)}`),
		size: 10,
		duration_ms: 1000
	},
	tool: {
		backend: 'whisper_cpp',
		version: '1.9.4',
		model,
		model_blake3: parse_or_throw(FactHashSchema, `blake3:${'cd'.repeat(32)}`),
		params: { language: 'auto' }
	},
	language: 'en',
	segments: []
});

/** Each recording's line, as it reads. */
const recording_texts = (): Array<string> =>
	Array.from(target.querySelectorAll('li')).map((el) => to_visible_text(el));

test('lists the audio files under the recordings folder at any depth, newest first, with their transcripts', async () => {
	disk.write(`${RECORDINGS}2026-11-01_10-00-00.webm`, null);
	disk.write(`${RECORDINGS}2026-11-03_10-00-00.webm`, null);
	disk.write(`${RECORDINGS}2026-11-02_10-00-00.webm`, null);
	disk.write(
		`${RECORDINGS}2026-11-02_10-00-00.webm.base.transcript.json`,
		JSON.stringify(create_transcript('base'))
	);
	// nested: a folder of older recordings
	disk.write(`${RECORDINGS}2025/2025-06-01_10-00-00.webm`, null);
	// not recordings: a file that isn't audio, and audio outside the folder
	disk.write(`${RECORDINGS}notes.txt`, 'notes');
	disk.write('/w/elsewhere.webm', null);

	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: RecordingsPage, props: {} }
	});
	flushSync();
	// the page loads the transcript candidates' contents, which say what each is of
	await flush_reads();
	flushSync();

	assert.deepEqual(recording_texts(), [
		'2026-11-03_10-00-00.webm transcribe',
		'2026-11-02_10-00-00.webm transcribed by base',
		'2026-11-01_10-00-00.webm transcribe',
		'2025-06-01_10-00-00.webm transcribe'
	]);
});

test('holds the transcript candidates while mounted, and lets go on unmount', () => {
	const audio = disk.write(`${RECORDINGS}2026-11-02_10-00-00.webm`, null);
	const transcript = disk.write(
		`${RECORDINGS}2026-11-02_10-00-00.webm.base.transcript.json`,
		JSON.stringify(create_transcript('base'))
	);

	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: RecordingsPage, props: {} }
	});
	flushSync();
	assert.isTrue(app.diskfiles.is_acquired(transcript.path));
	assert.isFalse(app.diskfiles.is_acquired(audio.path), 'the recording itself is only listed');

	void unmount(mounted);
	mounted = null;
	flushSync();
	assert.isFalse(app.diskfiles.is_acquired(transcript.path));
});
