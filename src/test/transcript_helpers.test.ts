import { FactHashSchema } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, assert } from 'vitest';

import {
	find_transcript_candidate_paths,
	find_transcripts,
	format_transcript_time,
	is_transcript_path,
	parse_transcript,
	to_transcript_copy_path,
	to_transcript_source_name,
	to_transcript_source_path,
	transcript_to_paragraphs,
	transcript_to_text
} from '#lib/transcript_helpers.ts';
import {
	TRANSCRIPT_MODEL_SLUG_REGEX,
	type Transcript,
	type TranscriptSegment
} from '#lib/transcript_types.ts';

const create_transcript = (model: string, segments: Array<TranscriptSegment> = []): Transcript => ({
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
		const transcript = { ...create_transcript('base.en'), future_field: 1 };
		const parsed = parse_transcript(JSON.stringify(transcript));
		assert.deepEqual(parsed, transcript);
	});

	test('is null for anything else', () => {
		for (const content of [null, '', 'not json', '[]', '{}', '{"version": 1}']) {
			assert.strictEqual(parse_transcript(content), null, String(content));
		}
		const bad_segment = { ...create_transcript('m'), segments: [{ text: 5 }] };
		assert.strictEqual(parse_transcript(JSON.stringify(bad_segment)), null);
	});

	test('refuses a hash that is not a fact hash', () => {
		const transcript = create_transcript('base.en');
		for (const hash of [
			'blake3:ab',
			`blake3:${'AB'.repeat(32)}`,
			`sha256:${'ab'.repeat(32)}`,
			'ab'.repeat(32),
			''
		]) {
			const bad_source = { ...transcript, source: { ...transcript.source, blake3: hash } };
			assert.strictEqual(parse_transcript(JSON.stringify(bad_source)), null, hash);
			const bad_model = { ...transcript, tool: { ...transcript.tool, model_blake3: hash } };
			assert.strictEqual(parse_transcript(JSON.stringify(bad_model)), null, hash);
		}
	});
});

describe('to_transcript_source_name', () => {
	test('is the sidecar name before the model slug', () => {
		for (const [sidecar, source] of [
			['/w/sub/a.webm.base-en.transcript.json', 'a.webm'],
			['a.webm.large-v3-turbo.transcript.json', 'a.webm'],
			['/w/my recording (2).ogg.m.transcript.json', 'my recording (2).ogg'],
			['/w/..a.webm.m.transcript.json', '..a.webm'],
			['/w/.hidden.wav.m.transcript.json', '.hidden.wav'],
			// a dotted slug can't be one, so its last segment is the slug
			['/w/a.webm.base.en.transcript.json', 'a.webm.base']
		] as const) {
			assert.strictEqual(to_transcript_source_name(sidecar), source, sidecar);
		}
	});

	// a sidecar is a file anyone can name, and its source name becomes a path the app plays from
	// and creates the editable copy beside
	test('is null for a name that names no plain file beside it', () => {
		for (const sidecar of [
			'/w/a.webm',
			'/w/transcript.json',
			'/w/m.transcript.json',
			'/w/..m.transcript.json',
			'/w/...m.transcript.json',
			'/w/.m.transcript.json',
			'/w/a\\b.webm.m.transcript.json',
			'/w/a\0.webm.m.transcript.json',
			'/w/a.webm.BASE.transcript.json',
			'/w/a.webm.b+c.transcript.json',
			'/w/a.webm..transcript.json'
		]) {
			assert.strictEqual(to_transcript_source_name(sidecar), null, JSON.stringify(sidecar));
		}
	});
	// mirrors the backend's `whisper_cpp::model_slugs_name_the_model`: a slug it writes must parse
	test('accepts every slug the backend emits', () => {
		for (const slug of [
			'large-v3-turbo',
			'base-en',
			'a--b',
			'large-v3-turbo-q5_0',
			'my-model--v2',
			'custom',
			'model'
		]) {
			assert.ok(TRANSCRIPT_MODEL_SLUG_REGEX.test(slug), slug);
		}
	});
});

describe('find_transcript_candidate_paths', () => {
	test('only names beside the source that parse back to it', () => {
		assert.deepEqual(
			find_transcript_candidate_paths(
				[
					'/w/a.webm.m.transcript.json',
					'/w/a.webm.d/x.m.transcript.json',
					'/w/a.webm.x.webm.m.transcript.json',
					'/w/a.webm.m.json'
				],
				'/w/a.webm'
			),
			['/w/a.webm.m.transcript.json']
		);
	});
});

describe('to_transcript_source_path', () => {
	test('is the named file beside the sidecar', () => {
		assert.strictEqual(
			to_transcript_source_path('/w/sub/a.webm.base-en.transcript.json'),
			'/w/sub/a.webm'
		);
		assert.strictEqual(to_transcript_source_path('/w/sub/m.transcript.json'), null);
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

	test('finds the sidecars named for the source, by model', () => {
		const turbo = file(
			'/w/a.webm.large-v3-turbo.transcript.json',
			create_transcript('large-v3-turbo')
		);
		const base = file('/w/a.webm.base-en.transcript.json', create_transcript('base-en'));
		const found = find_transcripts(
			[
				turbo,
				base,
				file('/w/a.webm', null),
				// another source whose name starts the same way
				file('/w/a.webm.bak.webm.base-en.transcript.json', create_transcript('base-en')),
				// a dotted slug names another source, `a.webm.base`
				file('/w/a.webm.base.en.transcript.json', create_transcript('base.en')),
				// named right, but not a transcript
				file('/w/a.webm.junk.transcript.json', 'not json'),
				// not loaded
				file('/w/a.webm.huge.transcript.json', null),
				// another directory's
				file('/x/a.webm.base-en.transcript.json', create_transcript('base-en')),
				file('/w/b.webm.base-en.transcript.json', create_transcript('base-en'))
			],
			'/w/a.webm'
		);
		assert.deepEqual(
			found.map((f) => f.file.path),
			[base.path, turbo.path]
		);
		assert.strictEqual(found[0]!.transcript.tool.model, 'base-en');
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
		const transcript = create_transcript('base.en', [
			segment(0, 1000, 'Hello there.'),
			segment(9000, 10_000, 'Later.')
		]);
		assert.strictEqual(
			transcript_to_text(transcript, 'standup.webm'),
			'./standup.webm\n\nHello there.\n\nLater.\n'
		);
	});

	test('is just the link for no speech', () => {
		assert.strictEqual(transcript_to_text(create_transcript('m'), 'a.ogg'), './a.ogg\n');
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
