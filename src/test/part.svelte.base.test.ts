// @vitest-environment jsdom

import {test, assert, describe, beforeEach} from 'vitest';

import {Part, TextPart, DiskfilePart} from '$lib/part.svelte.js';
import {create_uuid, get_datetime_now} from '$lib/zod_helpers.js';
import {DiskfileDirectoryPath, DiskfilePath} from '$lib/diskfile_types.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {estimate_token_count} from '$lib/helpers.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

// Test suite variables
let app: Frontend;

// Test constants
const TEST_CONTENT = {
	BASIC: 'Basic test content',
	SECONDARY: 'Secondary test content',
	EMPTY: '',
};

const TEST_PATH = DiskfilePath.parse('/path/to/test/file.txt');
const TEST_DIR = DiskfileDirectoryPath.parse('/path/');

beforeEach(() => {
	// Create a real Zzz instance for each test
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('Part base class functionality', () => {
	test('attribute management works across all part types', () => {
		const text_part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.BASIC,
		});

		const diskfile_part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			path: TEST_PATH,
		});

		for (const part of [text_part, diskfile_part]) {
			part.add_attribute({key: 'test-attr', value: 'test-value'});
			assert.strictEqual(part.attributes.length, 1);
			let first_attr = part.attributes[0];
			if (!first_attr) throw new Error('Expected first attribute');
			assert.strictEqual(first_attr.key, 'test-attr');
			assert.strictEqual(first_attr.value, 'test-value');

			const attr_id = first_attr.id;

			const updated = part.update_attribute(attr_id, {value: 'updated-value'});
			assert.ok(updated);
			first_attr = part.attributes[0];
			if (!first_attr) throw new Error('Expected attribute after update');
			assert.strictEqual(first_attr.key, 'test-attr');
			assert.strictEqual(first_attr.value, 'updated-value');

			part.update_attribute(attr_id, {key: 'updated-key', value: 'updated-value-2'});
			first_attr = part.attributes[0];
			if (!first_attr) throw new Error('Expected attribute after second update');
			assert.strictEqual(first_attr.key, 'updated-key');
			assert.strictEqual(first_attr.value, 'updated-value-2');

			part.remove_attribute(attr_id);
			assert.strictEqual(part.attributes.length, 0);

			const non_existent_update = part.update_attribute(create_uuid(), {
				value: 'test',
			});
			assert.ok(!non_existent_update);
		}
	});

	test('derived properties work correctly', () => {
		// Create a text part to test length and token properties
		const text_part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.BASIC,
		});

		// Test initial derivations
		assert.strictEqual(text_part.length, TEST_CONTENT.BASIC.length);
		assert.strictEqual(text_part.token_count, estimate_token_count(TEST_CONTENT.BASIC));

		// Test derivations after content change
		text_part.content = TEST_CONTENT.SECONDARY;

		assert.strictEqual(text_part.length, TEST_CONTENT.SECONDARY.length);
		assert.strictEqual(text_part.token_count, estimate_token_count(TEST_CONTENT.SECONDARY));
	});
});

describe('Part factory method', () => {
	test('Part.create creates the correct part type based on JSON', () => {
		const text_part = Part.create(app, {
			type: 'text',
			content: TEST_CONTENT.BASIC,
			name: 'Text Part',
		});

		const diskfile_part = Part.create(app, {
			type: 'diskfile',
			path: TEST_PATH,
			name: 'Diskfile Part',
		});

		assert.instanceOf(text_part, TextPart);
		assert.strictEqual(text_part.type, 'text');
		assert.strictEqual(text_part.name, 'Text Part');
		assert.strictEqual(text_part.content, TEST_CONTENT.BASIC);

		assert.instanceOf(diskfile_part, DiskfilePart);
		assert.strictEqual(diskfile_part.type, 'diskfile');
		assert.strictEqual(diskfile_part.name, 'Diskfile Part');
		assert.strictEqual(diskfile_part.path, TEST_PATH);
	});

	test('Part.create throws error for unknown part type', () => {
		const invalid_json = {
			type: 'unknown' as const,
		};

		assert.throws(() => Part.create(app, invalid_json as any), /Unreachable case: unknown/);
	});

	test('Part.create throws error for missing type field', () => {
		const invalid_json = {
			name: 'Test',
		};

		assert.throws(
			() => Part.create(app, invalid_json as any),
			/Missing required "type" field in part JSON/,
		);
	});
});

describe('TextPart specific behavior', () => {
	test('TextPart initialization and content management', () => {
		// Create with constructor
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.BASIC,
		});

		assert.strictEqual(part.type, 'text');
		assert.strictEqual(part.content, TEST_CONTENT.BASIC);

		// Test update method
		part.content = TEST_CONTENT.SECONDARY;
		assert.strictEqual(part.content, TEST_CONTENT.SECONDARY);

		// Test direct property assignment
		part.content = TEST_CONTENT.EMPTY;
		assert.strictEqual(part.content, TEST_CONTENT.EMPTY);
	});

	test('TextPart serialization and deserialization', () => {
		const test_id = create_uuid();
		const test_date = get_datetime_now();

		// Create part with all properties
		const original = app.cell_registry.instantiate('TextPart', {
			id: test_id,
			created: test_date,
			type: 'text',
			content: TEST_CONTENT.BASIC,
			name: 'Test part',
			has_xml_tag: true,
			xml_tag_name: 'test',
			start: 5,
			end: 15,
			enabled: false,
			title: 'Test Title',
			summary: 'Test Summary',
		});

		// Add attributes
		original.add_attribute({key: 'class', value: 'highlight'});

		// Serialize to JSON
		const json = original.to_json();

		// Create new part from JSON
		const restored = app.cell_registry.instantiate('TextPart', json);

		// Verify all properties were preserved
		assert.strictEqual(restored.id, test_id);
		assert.strictEqual(restored.created, test_date);
		assert.strictEqual(restored.content, TEST_CONTENT.BASIC);
		assert.strictEqual(restored.name, 'Test part');
		assert.ok(restored.has_xml_tag);
		assert.strictEqual(restored.xml_tag_name, 'test');
		assert.strictEqual(restored.start, 5);
		assert.strictEqual(restored.end, 15);
		assert.ok(!restored.enabled);
		assert.strictEqual(restored.title, 'Test Title');
		assert.strictEqual(restored.summary, 'Test Summary');
		assert.strictEqual(restored.attributes.length, 1);
		const restored_attr = restored.attributes[0];
		if (!restored_attr) throw new Error('Expected restored attribute');
		assert.strictEqual(restored_attr.key, 'class');
		assert.strictEqual(restored_attr.value, 'highlight');
	});

	test('TextPart cloning creates independent copy', () => {
		// Create original part
		const original = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.BASIC,
			name: 'Original',
		});

		// Clone the part
		const clone = original.clone();

		// Verify initial state is the same except id
		assert.ok(clone.id !== original.id);
		assert.strictEqual(clone.content, original.content);
		assert.strictEqual(clone.name, original.name);

		// Modify clone
		clone.content = TEST_CONTENT.SECONDARY;
		clone.name = 'Modified';

		// Verify original remains unchanged
		assert.strictEqual(original.content, TEST_CONTENT.BASIC);
		assert.strictEqual(original.name, 'Original');

		// Verify clone has new values
		assert.strictEqual(clone.content, TEST_CONTENT.SECONDARY);
		assert.strictEqual(clone.name, 'Modified');
	});
});

describe('DiskfilePart specific behavior', () => {
	test('DiskfilePart initialization and content access', () => {
		// Create a diskfile first
		const diskfile = app.diskfiles.add({
			path: TEST_PATH,
			source_dir: TEST_DIR,
			content: TEST_CONTENT.BASIC,
		});

		// Create diskfile part that references the diskfile
		const part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			path: TEST_PATH,
		});

		// Test basic properties
		assert.strictEqual(part.type, 'diskfile');
		assert.strictEqual(part.path, TEST_PATH);
		assert.deepEqual(part.diskfile, diskfile);
		assert.strictEqual(part.content, TEST_CONTENT.BASIC);

		// Update content through part
		part.content = TEST_CONTENT.SECONDARY;

		// Verify both part and diskfile were updated
		assert.strictEqual(part.content, TEST_CONTENT.SECONDARY);
		assert.strictEqual(part.diskfile?.content, TEST_CONTENT.SECONDARY);
	});

	test('DiskfilePart handles null path properly', () => {
		const part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			path: null,
		});

		assert.isNull(part.path);
		assert.isNull(part.diskfile);
		assert.isUndefined(part.content);
	});

	test('DiskfilePart handles changing path', () => {
		// Create two diskfiles
		const path1 = DiskfilePath.parse('/path/to/file1.txt');
		const path2 = DiskfilePath.parse('/path/to/file2.txt');

		app.diskfiles.add({
			path: path1,
			source_dir: DiskfileDirectoryPath.parse('/path/'),
			content: 'File 1 content',
		});

		app.diskfiles.add({
			path: path2,
			source_dir: DiskfileDirectoryPath.parse('/path/'),
			content: 'File 2 content',
		});

		// Create part referencing first file
		const part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			path: path1,
		});

		assert.strictEqual(part.path, path1);
		assert.strictEqual(part.content, 'File 1 content');

		// Change path to reference second file
		part.path = path2;

		assert.strictEqual(part.path, path2);
		assert.strictEqual(part.content, 'File 2 content');
	});
});

describe('Common part behavior across types', () => {
	test('Position markers work across part types', () => {
		const text_part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.BASIC,
			start: 5,
			end: 10,
		});

		const diskfile_part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			path: TEST_PATH,
			start: 15,
			end: 20,
		});

		assert.strictEqual(text_part.start, 5);
		assert.strictEqual(text_part.end, 10);

		assert.strictEqual(diskfile_part.start, 15);
		assert.strictEqual(diskfile_part.end, 20);

		text_part.start = 6;
		text_part.end = 11;

		diskfile_part.start = 16;
		diskfile_part.end = 21;

		assert.strictEqual(text_part.start, 6);
		assert.strictEqual(text_part.end, 11);

		assert.strictEqual(diskfile_part.start, 16);
		assert.strictEqual(diskfile_part.end, 21);
	});

	test('XML tag properties work across part types', () => {
		const text_part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			has_xml_tag: true,
			xml_tag_name: 'text-tag',
		});

		const diskfile_part = app.cell_registry.instantiate('DiskfilePart', {
			type: 'diskfile',
			has_xml_tag: true,
			xml_tag_name: 'file-tag',
		});

		assert.ok(text_part.has_xml_tag);
		assert.strictEqual(text_part.xml_tag_name, 'text-tag');

		assert.ok(diskfile_part.has_xml_tag);
		assert.strictEqual(diskfile_part.xml_tag_name, 'file-tag');

		text_part.has_xml_tag = false;
		text_part.xml_tag_name = '';

		diskfile_part.xml_tag_name = 'updated-file-tag';

		assert.ok(!text_part.has_xml_tag);
		assert.strictEqual(text_part.xml_tag_name, '');

		assert.ok(diskfile_part.has_xml_tag);
		assert.strictEqual(diskfile_part.xml_tag_name, 'updated-file-tag');
	});

	test('has_xml_tag defaults correctly for each part type', () => {
		const text_part = app.cell_registry.instantiate('TextPart');
		const diskfile_part = app.cell_registry.instantiate('DiskfilePart');

		assert.ok(!text_part.has_xml_tag);
		assert.ok(diskfile_part.has_xml_tag);

		const custom_text_part = app.cell_registry.instantiate('TextPart', {
			has_xml_tag: true,
		});
		const custom_diskfile_part = app.cell_registry.instantiate('DiskfilePart', {
			has_xml_tag: false,
		});

		assert.ok(custom_text_part.has_xml_tag);
		assert.ok(!custom_diskfile_part.has_xml_tag);
	});
});
