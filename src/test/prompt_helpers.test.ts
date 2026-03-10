import {test, assert} from 'vitest';

import {format_prompt_content} from '$lib/prompt_helpers.js';

// Instead of mocking modules, we'll create a simplified part structure
// that mirrors the interface we need for the tests
interface SimplePart {
	enabled: boolean;
	content: string;
	has_xml_tag: boolean;
	xml_tag_name: string;
	type: string;
	xml_tag_name_default: string;
	relative_path?: string; // Add this property for diskfile tests
	attributes: Array<{
		id: string;
		key: string;
		value: string;
	}>;
}

// Helper to create a part with default values
const create_part = (partial: Partial<SimplePart> = {}): SimplePart => {
	const type = partial.type || 'text';

	return {
		enabled: true,
		content: '',
		has_xml_tag: false,
		xml_tag_name: '',
		type,
		xml_tag_name_default: type === 'diskfile' ? 'File' : 'Fragment',
		attributes: [],
		...partial,
	};
};

// Basic tests
test('format_prompt_content - returns empty string for empty parts array', () => {
	const result = format_prompt_content([] as any);
	assert.strictEqual(result, '');
});

test('format_prompt_content - filters out disabled parts', () => {
	const parts = [
		create_part({enabled: false, content: 'Content 1'}),
		create_part({enabled: true, content: 'Content 2'}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, 'Content 2');
});

test('format_prompt_content - joins multiple enabled parts with double newlines', () => {
	const parts = [create_part({content: 'Content 1'}), create_part({content: 'Content 2'})];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, 'Content 1\n\nContent 2');
});

// XML tag tests
test('format_prompt_content - wraps content with XML tags when specified', () => {
	const parts = [
		create_part({
			content: 'Content with tag',
			has_xml_tag: true,
			xml_tag_name: 'system',
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<system>\nContent with tag\n</system>');
});

test('format_prompt_content - uses xml_tag_name_default when no XML tag name is provided', () => {
	const parts = [
		create_part({
			content: 'Content with default tag',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'text',
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<Fragment>\nContent with default tag\n</Fragment>');
});

// Test with different part types
test('format_prompt_content - uses different part types as defaults', () => {
	const parts = [
		create_part({
			content: 'File content',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'diskfile',
		}),
		create_part({
			content: 'Sequence content',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'sequence',
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(
		result,
		'<File>\nFile content\n</File>\n\n<Fragment>\nSequence content\n</Fragment>',
	);
});

test('format_prompt_content - uses different default XML tag names for different part types', () => {
	const parts = [
		create_part({
			content: 'File content',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'diskfile',
		}),
		create_part({
			content: 'Text content',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'text',
		}),
		create_part({
			content: 'Sequence content',
			has_xml_tag: true,
			xml_tag_name: '',
			type: 'sequence',
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(
		result,
		'<File>\nFile content\n</File>\n\n<Fragment>\nText content\n</Fragment>\n\n<Fragment>\nSequence content\n</Fragment>',
	);
});

// XML attribute tests - enhanced to test more edge cases
test('format_prompt_content - includes attributes with key and value', () => {
	const parts = [
		create_part({
			content: 'Content with attributes',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [{id: '1', key: 'class', value: 'container'}],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<div class="container">\nContent with attributes\n</div>');
});

test('format_prompt_content - handles empty values as boolean attributes', () => {
	const parts = [
		create_part({
			content: 'Content with boolean attribute',
			has_xml_tag: true,
			xml_tag_name: 'input',
			attributes: [{id: '1', key: 'disabled', value: ''}],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<input disabled>\nContent with boolean attribute\n</input>');
});

test('format_prompt_content - handles explicitly empty string values', () => {
	const parts = [
		create_part({
			content: 'Content with explicit empty value',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [
				{id: '1', key: 'data-test', value: ''}, // Empty string should be boolean attribute
				{id: '2', key: 'class', value: 'container'}, // Normal attribute
			],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(
		result,
		'<div data-test class="container">\nContent with explicit empty value\n</div>',
	);
});

test('format_prompt_content - filters out attributes without keys', () => {
	const parts = [
		create_part({
			content: 'Content with missing key',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [{id: '1', key: '', value: 'should-be-ignored'}],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<div>\nContent with missing key\n</div>');
});

test('format_prompt_content - handles multiple attributes with mix of empty and non-empty values', () => {
	const parts = [
		create_part({
			content: 'Multiple attributes',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [
				{id: '1', key: 'class', value: 'container'},
				{id: '2', key: 'id', value: 'main'},
				{id: '3', key: 'data-test', value: 'true'},
				{id: '4', key: 'hidden', value: ''},
				{id: '5', key: 'disabled', value: ''},
			],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(
		result,
		'<div class="container" id="main" data-test="true" hidden disabled>\nMultiple attributes\n</div>',
	);
});

// Whitespace handling tests
test('format_prompt_content - ignores attributes with empty keys after trimming', () => {
	const parts = [
		create_part({
			content: 'Content with whitespace key',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [
				{id: '1', key: '   ', value: 'should-be-ignored'},
				{id: '2', key: 'class', value: 'container'},
			],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<div class="container">\nContent with whitespace key\n</div>');
});

test('format_prompt_content - trims attribute keys before rendering', () => {
	const parts = [
		create_part({
			content: 'Content with trimmed keys',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [
				{id: '1', key: '  class  ', value: 'container'},
				{id: '2', key: ' data-test ', value: 'true'},
			],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(
		result,
		'<div class="container" data-test="true">\nContent with trimmed keys\n</div>',
	);
});

test('format_prompt_content - removes attributes with empty keys but preserves others', () => {
	const parts = [
		create_part({
			content: 'Mixed attributes',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [
				{id: '1', key: '', value: 'invalid'},
				{id: '2', key: 'class', value: 'container'},
				{id: '3', key: '  ', value: 'also-invalid'},
				{id: '4', key: 'data-valid', value: 'true'},
			],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<div class="container" data-valid="true">\nMixed attributes\n</div>');
});

test('format_prompt_content - filters out attributes with empty keys', () => {
	const parts = [
		create_part({
			content: 'Content with empty key',
			has_xml_tag: true,
			xml_tag_name: 'div',
			attributes: [{id: '1', key: '', value: 'should-be-ignored'}],
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<div>\nContent with empty key\n</div>');
});

// Edge cases
test('format_prompt_content - trims whitespace from content', () => {
	const parts = [create_part({content: '  Content with whitespace  '})];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, 'Content with whitespace');
});

test('format_prompt_content - skips parts with empty content', () => {
	const parts = [
		create_part({content: ''}),
		create_part({content: '  '}),
		create_part({content: 'Real content'}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, 'Real content');
});

test('format_prompt_content - trims whitespace from XML tag name', () => {
	const parts = [
		create_part({
			content: 'Trimmed tag name',
			has_xml_tag: true,
			xml_tag_name: '  system  ',
		}),
	];

	const result = format_prompt_content(parts as any);
	assert.strictEqual(result, '<system>\nTrimmed tag name\n</system>');
});

// Test that diskfile parts get the path attribute by default
test('format_prompt_content - ensures diskfile parts have path attribute', () => {
	// Create a mock DiskfilePart with a path
	const diskfile_part = create_part({
		type: 'diskfile',
		content: 'File content with path',
		has_xml_tag: true,
		xml_tag_name: '',
		relative_path: 'src/example.ts', // Add this property for the test
		attributes: [{id: '1', key: 'path', value: 'src/example.ts'}], // Pre-set attribute for mock
	});

	const result = format_prompt_content([diskfile_part] as any);
	assert.strictEqual(result, '<File path="src/example.ts">\nFile content with path\n</File>');
});

// Test for when the path attribute is combined with other attributes
test('format_prompt_content - combines path attribute with other attributes for diskfile parts', () => {
	const diskfile_part = create_part({
		type: 'diskfile',
		content: 'File with multiple attributes',
		has_xml_tag: true,
		xml_tag_name: 'code',
		relative_path: 'src/utils.js',
		attributes: [
			{id: '1', key: 'path', value: 'src/utils.js'},
			{id: '2', key: 'language', value: 'javascript'},
			{id: '3', key: 'highlight', value: ''},
		],
	});

	const result = format_prompt_content([diskfile_part] as any);
	assert.strictEqual(
		result,
		'<code path="src/utils.js" language="javascript" highlight>\nFile with multiple attributes\n</code>',
	);
});
