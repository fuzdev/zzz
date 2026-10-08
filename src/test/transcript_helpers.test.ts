import { test, describe, assert } from 'vitest';

import {
	find_transcripts,
	format_transcript_time,
	is_transcript_path,
	parse_transcript,
	to_transcript_copy_path,
	to_transcript_source_path,
	transcript_to_paragraphs,
	transcript_to_text
} from '$lib/transcript_helpers.ts';
import type { Transcript, TranscriptSegment } from '$lib/transcript_types.ts';

const create_transcript = (
	source_name: string,
	model: string,
	segments: Array<TranscriptSegment> = []
): Transcript => ({
	version: 1,
	source: { name: source_name, blake3: 'blake3:ab', size: 10, duration_ms: 1000 },
	tool: {
		backend: 'whisper_cpp',
		version: '1.9.4',
		model,
		model_blake3: 'blake3:cd',
		params: { language: 'auto' }
	},
	language: 'en',
	segments
});

const segment = (
	start_ms: number | null,
	end_ms: number | null,
	text: string
): TranscriptSegment => ({
	start_ms,
	end_ms,
	text
});

describe('is_transcript_path', () => {
	test('goes by the suffix', () => {
		assert.ok(is_transcript_path('/w/a.webm.base.en.transcript.json'));
		assert.ok(!is_transcript_path('/w/a.webm'));
		assert.ok(!is_transcript_path('/w/a.transcript.json.bak'));
		assert.ok(!is_transcript_path('/w/transcript.json'));
	});
});

describe('parse_transcript', () => {
	test('parses a transcript, keeping fields it does not know', () => {
		const transcript = { ...create_transcript('a.webm', 'base.en'), future_field: 1 };
		const parsed = parse_transcript(JSON.stringify(transcript));
		assert.deepEqual(parsed, transcript);
	});

	test('is null for anything else', () => {
		for (const content of [null, '', 'not json', '[]', '{}', '{"version": 1}']) {
			assert.strictEqual(parse_transcript(content), null, String(content));
		}
		const bad_segment = { ...create_transcript('a.webm', 'm'), segments: [{ text: 5 }] };
		assert.strictEqual(parse_transcript(JSON.stringify(bad_segment)), null);
	});

	// a sidecar is a file anyone can write, and its source name becomes a path
	// the app plays from and creates the editable copy beside
	test('refuses a source name that is a path', () => {
		for (const name of [
			'../../other/.claude/commands/ship',
			'sub/a.webm',
			'/etc/passwd',
			'..',
			'.',
			'',
			'a\\b.webm',
			'a\0.webm'
		]) {
			const transcript = create_transcript(name, 'base.en');
			assert.strictEqual(parse_transcript(JSON.stringify(transcript)), null, JSON.stringify(name));
		}
		// dots and spaces in a plain name are fine
		for (const name of ['a.webm', '..a.webm', 'my recording (2).ogg', '.hidden.wav']) {
			assert.ok(parse_transcript(JSON.stringify(create_transcript(name, 'm'))), name);
		}
	});
});

describe('to_transcript_source_path', () => {
	test('is the named file beside the sidecar', () => {
		assert.strictEqual(
			to_transcript_source_path(
				'/w/sub/a.webm.base.en.transcript.json',
				create_transcript('a.webm', 'base.en')
			),
			'/w/sub/a.webm'
		);
	});
});

describe('find_transcripts', () => {
	const file = (path: string, transcript: Transcript | string | null) => ({
		path,
		content:
			transcript === null || typeof transcript === 'string'
				? transcript
				: JSON.stringify(transcript)
	});

	test('finds the sidecars made from the source, by model', () => {
		const turbo = file(
			'/w/a.webm.large-v3-turbo.transcript.json',
			create_transcript('a.webm', 'large-v3-turbo')
		);
		const base = file('/w/a.webm.base.en.transcript.json', create_transcript('a.webm', 'base.en'));
		const found = find_transcripts(
			[
				turbo,
				base,
				file('/w/a.webm', null),
				// another source whose name starts the same way
				file(
					'/w/a.webm.bak.webm.base.en.transcript.json',
					create_transcript('a.webm.bak.webm', 'base.en')
				),
				// named right, but not a transcript
				file('/w/a.webm.junk.transcript.json', 'not json'),
				// not loaded
				file('/w/a.webm.huge.transcript.json', null),
				// another directory's
				file('/x/a.webm.base.en.transcript.json', create_transcript('a.webm', 'base.en')),
				file('/w/b.webm.base.en.transcript.json', create_transcript('b.webm', 'base.en'))
			],
			'/w/a.webm'
		);
		assert.deepEqual(
			found.map((f) => f.file.path),
			[base.path, turbo.path]
		);
		assert.strictEqual(found[0]!.transcript.tool.model, 'base.en');
	});

	test('finds nothing for a source with no sidecar', () => {
		assert.deepEqual(find_transcripts([file('/w/a.webm', null)], '/w/a.webm'), []);
	});
});

describe('format_transcript_time', () => {
	test('formats minutes, then hours', () => {
		assert.strictEqual(format_transcript_time(0), '0:00');
		assert.strictEqual(format_transcript_time(71_250), '1:11');
		assert.strictEqual(format_transcript_time(3_600_001), '1:00:00');
		assert.strictEqual(format_transcript_time(-1), '0:00');
	});
});

describe('transcript_to_paragraphs', () => {
	test('joins segments, breaking at long pauses', () => {
		assert.deepEqual(
			transcript_to_paragraphs([
				segment(0, 1000, ' One.'),
				segment(1200, 2000, 'Two. '),
				segment(4000, 5000, 'Three.'),
				segment(5100, 6000, '  '),
				segment(6000, 7000, 'Four.')
			]),
			['One. Two.', 'Three. Four.']
		);
	});

	test('never breaks on untimed segments', () => {
		assert.deepEqual(
			transcript_to_paragraphs([
				segment(0, 1000, 'One.'),
				segment(null, null, 'Two.'),
				segment(null, null, 'Three.')
			]),
			['One. Two. Three.']
		);
	});

	test('is empty for no speech', () => {
		assert.deepEqual(transcript_to_paragraphs([]), []);
		assert.deepEqual(transcript_to_paragraphs([segment(0, 1, ' ')]), []);
	});
});

describe('transcript_to_text', () => {
	test('links the source, then the paragraphs', () => {
		const transcript = create_transcript('standup.webm', 'base.en', [
			segment(0, 1000, 'Hello there.'),
			segment(9000, 10_000, 'Later.')
		]);
		assert.strictEqual(
			transcript_to_text(transcript),
			'./standup.webm\n\nHello there.\n\nLater.\n'
		);
	});

	test('is just the link for no speech', () => {
		assert.strictEqual(transcript_to_text(create_transcript('a.ogg', 'm')), './a.ogg\n');
	});
});

describe('to_transcript_copy_path', () => {
	test('takes the first free name', () => {
		const taken = new Set(['/w/a.webm.md', '/w/a.webm.2.md']);
		assert.strictEqual(
			to_transcript_copy_path('/w/b.webm', (path) => taken.has(path)),
			'/w/b.webm.md'
		);
		assert.strictEqual(
			to_transcript_copy_path('/w/a.webm', (path) => taken.has(path)),
			'/w/a.webm.3.md'
		);
	});
});
