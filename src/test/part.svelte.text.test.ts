// @vitest-environment jsdom

import {test, describe, beforeEach, assert} from 'vitest';

import {estimate_token_count} from '$lib/helpers.js';
import {create_uuid, get_datetime_now} from '$lib/zod_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

// Test suite variables
let app: Frontend;

// Test data constants for reuse
const TEST_CONTENT = {
	EMPTY: '',
	INITIAL: 'Initial content',
	NEW_CONTENT: 'New and longer content',
	SOMETHING: 'Something else entirely',
	LONG: 'a'.repeat(10000),
	UNICODE: '😀🌍🏠👨‍👩‍👧‍👦',
	SPECIAL_CHARS: 'Tab:\t Newline:\n Quote:" Backslash:\\',
	CODE: `
function test() {
	return "Hello World";
}

<div class="test">This is <strong>HTML</strong> content</div>
`.trim(),
};

// Setup function to create a real Zzz instance
beforeEach(() => {
	// Create a real Zzz instance
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('TextPart initialization', () => {
	test('creates with default values when no options provided', () => {
		const part = app.cell_registry.instantiate('TextPart');

		assert.strictEqual(part.type, 'text');
		assert.strictEqual(part.content, TEST_CONTENT.EMPTY);
		assert.strictEqual(part.length, TEST_CONTENT.EMPTY.length);
		assert.strictEqual(part.token_count, 0);
		assert.strictEqual(part.name, '');
		assert.ok(part.enabled);
		assert.ok(!(part.has_xml_tag));
		assert.strictEqual(part.xml_tag_name, '');
		assert.deepEqual(part.attributes, []);
		assert.isNull(part.start);
		assert.isNull(part.end);
	});

	test('initializes with direct content property', () => {
		const content = TEST_CONTENT.INITIAL;
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content,
		});

		assert.strictEqual(part.content, content);
		assert.strictEqual(part.length, content.length);
		assert.strictEqual(part.token_count, estimate_token_count(content));
	});

	test('initializes from json with complete properties', () => {
		const test_id = create_uuid();
		const test_date = get_datetime_now();

		const part = app.cell_registry.instantiate('TextPart', {
			id: test_id,
			created: test_date,
			type: 'text',
			content: 'Json content',
			name: 'Test name',
			has_xml_tag: true,
			xml_tag_name: 'test-element',
			title: 'Test Title',
			summary: 'Test summary text',
			start: 5,
			end: 20,
			enabled: false,
			attributes: [{id: create_uuid(), key: 'attr1', value: 'value1'}],
		});

		assert.strictEqual(part.id, test_id);
		assert.strictEqual(part.created, test_date);
		assert.strictEqual(part.content, 'Json content');
		assert.strictEqual(part.name, 'Test name');
		assert.ok(part.has_xml_tag);
		assert.strictEqual(part.xml_tag_name, 'test-element');
		assert.strictEqual(part.title, 'Test Title');
		assert.strictEqual(part.summary, 'Test summary text');
		assert.strictEqual(part.start, 5);
		assert.strictEqual(part.end, 20);
		assert.ok(!(part.enabled));
		assert.strictEqual((part.attributes).length, 1);
		const first_attr = part.attributes[0];
		if (!first_attr) throw new Error('Expected first attribute');
		assert.strictEqual(first_attr.key, 'attr1');
		assert.strictEqual(first_attr.value, 'value1');
	});
});

describe('TextPart reactive properties', () => {
	test('derived properties update when content changes', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.INITIAL,
		});

		// Verify initial state
		assert.strictEqual(part.content, TEST_CONTENT.INITIAL);
		assert.strictEqual(part.length, TEST_CONTENT.INITIAL.length);
		const initial_token_count = part.token_count;

		// Change content
		part.content = TEST_CONTENT.NEW_CONTENT;

		// Verify derived properties update automatically
		assert.strictEqual(part.content, TEST_CONTENT.NEW_CONTENT);
		assert.strictEqual(part.length, TEST_CONTENT.NEW_CONTENT.length);
		assert.notStrictEqual(part.token_count, initial_token_count);
		assert.deepEqual(part.token_count, estimate_token_count(TEST_CONTENT.NEW_CONTENT));
	});

	test('length is zero when content is empty', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.EMPTY,
		});

		assert.strictEqual(part.content, TEST_CONTENT.EMPTY);
		assert.strictEqual(part.length, TEST_CONTENT.EMPTY.length);

		part.content = TEST_CONTENT.SOMETHING;
		assert.strictEqual(part.length, TEST_CONTENT.SOMETHING.length);

		part.content = TEST_CONTENT.EMPTY;
		assert.strictEqual(part.length, TEST_CONTENT.EMPTY.length);
	});
});

describe('TextPart serialization', () => {
	test('to_json includes all properties with correct values', () => {
		const test_id = create_uuid();
		const created = get_datetime_now();

		const part = app.cell_registry.instantiate('TextPart', {
			id: test_id,
			created,
			type: 'text',
			content: 'Test content',
			name: 'Test part',
			start: 10,
			end: 20,
		});

		const json = part.to_json();

		assert.strictEqual(json.id, test_id);
		assert.strictEqual(json.type, 'text');
		assert.strictEqual(json.created, created);
		assert.strictEqual(json.content, 'Test content');
		assert.strictEqual(json.name, 'Test part');
		assert.strictEqual(json.start, 10);
		assert.strictEqual(json.end, 20);
		assert.ok(!(json.has_xml_tag));
		assert.ok(json.enabled);
	});

	test('clone creates independent copy with same values', () => {
		const ORIGINAL = {
			CONTENT: 'Original content',
			NAME: 'Original name',
		};
		const MODIFIED = {
			CONTENT: 'Modified content',
			NAME: 'Modified name',
		};

		const original = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: ORIGINAL.CONTENT,
			name: ORIGINAL.NAME,
		});

		const clone = original.clone();

		// Verify they have same initial values except id
		assert.notStrictEqual(clone.id, original.id);
		assert.strictEqual(clone.content, ORIGINAL.CONTENT);
		assert.strictEqual(clone.name, ORIGINAL.NAME);

		// Verify they're independent objects
		clone.content = MODIFIED.CONTENT;
		clone.name = MODIFIED.NAME;

		assert.strictEqual(original.content, ORIGINAL.CONTENT);
		assert.strictEqual(original.name, ORIGINAL.NAME);
		assert.strictEqual(clone.content, MODIFIED.CONTENT);
		assert.strictEqual(clone.name, MODIFIED.NAME);
	});
});

describe('TextPart content modification', () => {
	test('update_content method directly updates content', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.INITIAL,
		});

		// Initial state
		assert.strictEqual(part.content, TEST_CONTENT.INITIAL);

		// Update content using assignment
		part.content = TEST_CONTENT.NEW_CONTENT;

		// Verify content was updated
		assert.strictEqual(part.content, TEST_CONTENT.NEW_CONTENT);
	});

	test('content setter directly updates content', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.INITIAL,
		});

		// Initial state
		assert.strictEqual(part.content, TEST_CONTENT.INITIAL);

		// Update content using setter
		part.content = TEST_CONTENT.NEW_CONTENT;

		// Verify content was updated
		assert.strictEqual(part.content, TEST_CONTENT.NEW_CONTENT);
	});
});

describe('TextPart content edge cases', () => {
	test('handles long content correctly', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.LONG,
		});

		assert.strictEqual(part.content, TEST_CONTENT.LONG);
		assert.strictEqual(part.length, TEST_CONTENT.LONG.length);
		assert.ok(part.token_count! > 0);
	});

	test('handles unicode characters correctly', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.UNICODE,
		});

		assert.strictEqual(part.content, TEST_CONTENT.UNICODE);
		assert.strictEqual(part.length, TEST_CONTENT.UNICODE.length);
		assert.deepEqual(part.token_count, estimate_token_count(TEST_CONTENT.UNICODE));
	});

	test('handles special characters correctly', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.SPECIAL_CHARS,
		});

		assert.strictEqual(part.content, TEST_CONTENT.SPECIAL_CHARS);
		assert.strictEqual(part.length, TEST_CONTENT.SPECIAL_CHARS.length);
		assert.deepEqual(part.token_count, estimate_token_count(TEST_CONTENT.SPECIAL_CHARS));
	});

	test('handles code and markup content correctly', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: TEST_CONTENT.CODE,
		});

		assert.strictEqual(part.content, TEST_CONTENT.CODE);
		assert.strictEqual(part.length, TEST_CONTENT.CODE.length);
		assert.deepEqual(part.token_count, estimate_token_count(TEST_CONTENT.CODE));
	});
});

describe('TextPart attribute management', () => {
	test('can add, update and remove attributes', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Test content',
		});

		// Add attribute
		part.add_attribute({key: 'class', value: 'highlight'});
		assert.strictEqual((part.attributes).length, 1);
		let first_attr = part.attributes[0];
		if (!first_attr) throw new Error('Expected first attribute');
		assert.strictEqual(first_attr.key, 'class');
		assert.strictEqual(first_attr.value, 'highlight');

		const attr_id = first_attr.id;

		// Update attribute
		const updated = part.update_attribute(attr_id, {value: 'special-highlight'});
		assert.ok(updated);
		first_attr = part.attributes[0];
		if (!first_attr) throw new Error('Expected attribute after update');
		assert.strictEqual(first_attr.key, 'class');
		assert.strictEqual(first_attr.value, 'special-highlight');

		// Remove attribute
		part.remove_attribute(attr_id);
		assert.strictEqual((part.attributes).length, 0);

		// Attempting to update non-existent attribute returns false
		const fake_update = part.update_attribute(create_uuid(), {key: 'test', value: 'test'});
		assert.ok(!(fake_update));
	});

	test('updates attribute key and value together', () => {
		const part = app.cell_registry.instantiate('TextPart');

		part.add_attribute({key: 'class', value: 'highlight'});
		const first_attr = part.attributes[0];
		if (!first_attr) throw new Error('Expected first attribute');
		const attr_id = first_attr.id;

		// Update both key and value
		const updated = part.update_attribute(attr_id, {key: 'data-type', value: 'important'});
		assert.ok(updated);
		const updated_attr = part.attributes[0];
		if (!updated_attr) throw new Error('Expected attribute after update');
		assert.strictEqual(updated_attr.key, 'data-type');
		assert.strictEqual(updated_attr.value, 'important');
	});

	test('attributes are preserved when serializing to JSON', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Test content',
		});

		part.add_attribute({key: 'data-test', value: 'true'});
		part.add_attribute({key: 'class', value: 'important'});

		const json = part.to_json();

		assert.strictEqual((json.attributes).length, 2);
		const json_attr0 = json.attributes[0];
		const json_attr1 = json.attributes[1];
		if (!json_attr0 || !json_attr1) throw new Error('Expected both attributes in JSON');
		assert.strictEqual(json_attr0.key, 'data-test');
		assert.strictEqual(json_attr1.key, 'class');

		// Verify they're properly restored
		const new_part = app.cell_registry.instantiate('TextPart', json);

		assert.strictEqual((new_part.attributes).length, 2);
		const new_attr0 = new_part.attributes[0];
		const new_attr1 = new_part.attributes[1];
		if (!new_attr0 || !new_attr1) throw new Error('Expected both attributes in restored part');
		assert.strictEqual(new_attr0.key, 'data-test');
		assert.strictEqual(new_attr1.key, 'class');
	});
});

describe('TextPart instance management', () => {
	test('part is added to registry when created', () => {
		// Create a part
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Registry test content',
		});

		// Add to the registry
		app.parts.items.add(part);

		// Verify it's in the registry
		const retrieved_part = app.parts.items.by_id.get(part.id);
		assert.strictEqual(retrieved_part, part);
	});

	test('part is removed from registry when requested', () => {
		// Create a part and add to registry
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Removable content',
		});

		app.parts.items.add(part);

		// Verify it's in the registry
		assert.strictEqual(app.parts.items.by_id.get(part.id), part);

		// Remove from registry
		app.parts.items.remove(part.id);

		// Verify it's gone
		assert.ok(app.parts.items.by_id.get(part.id) === undefined);
	});
});

describe('TextPart start and end position markers', () => {
	test('start and end positions are initialized properly', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Position test',
			start: 10,
			end: 25,
		});

		assert.strictEqual(part.start, 10);
		assert.strictEqual(part.end, 25);
	});

	test('start and end positions can be updated', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Position test',
		});

		// Initial values are null
		assert.isNull(part.start);
		assert.isNull(part.end);

		// Update positions
		part.start = 5;
		part.end = 15;

		assert.strictEqual(part.start, 5);
		assert.strictEqual(part.end, 15);
	});

	test('positions are preserved when serializing and deserializing', () => {
		const part = app.cell_registry.instantiate('TextPart', {
			type: 'text',
			content: 'Position preservation test',
			start: 8,
			end: 30,
		});

		// Serialize to JSON
		const json = part.to_json();

		// Create new part from JSON
		const new_part = app.cell_registry.instantiate('TextPart', json);

		// Verify positions were preserved
		assert.strictEqual(new_part.start, 8);
		assert.strictEqual(new_part.end, 30);
	});
});
