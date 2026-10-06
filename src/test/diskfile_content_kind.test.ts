import { test, describe, assert } from 'vitest';

import { AUDIO_EXTENSIONS, to_diskfile_content_kind } from '$lib/diskfile_content_kind.ts';
import { RECORDING_FORMATS } from '$lib/recording_helpers.ts';

describe('to_diskfile_content_kind', () => {
	test('reads audio from the extension, whatever its case', () => {
		for (const path of ['/w/a.webm', '/w/a.OGG', '/w/a.b.mp3', 'clip.wav', '/w/.hidden.flac']) {
			assert.strictEqual(to_diskfile_content_kind(path), 'audio', path);
		}
	});

	test('everything else is other', () => {
		for (const path of [
			'/w/a.txt',
			'/w/a.json',
			'/w/a.mp4',
			'/w/webm',
			'/w/a.webm/readme',
			'/w/a.',
			'/w.ogg/a',
			''
		]) {
			assert.strictEqual(to_diskfile_content_kind(path), 'other', path);
		}
	});

	test('a transcript sidecar is a transcript, whatever it sits beside', () => {
		for (const path of ['/w/a.webm.base.en.transcript.json', 'x.transcript.json']) {
			assert.strictEqual(to_diskfile_content_kind(path), 'transcript', path);
		}
		assert.strictEqual(to_diskfile_content_kind('/w/a.transcript.json.webm'), 'audio');
	});

	test('every format the recorder writes is viewed as audio', () => {
		for (const format of RECORDING_FORMATS) {
			assert.ok(AUDIO_EXTENSIONS.has(format.extension), format.extension);
		}
	});
});
