import {test, describe, assert} from 'vitest';

import {update_env_variable} from '$lib/server/env_file_helpers.js';

const create_mock_fs = (initial_files: Record<string, string> = {}) => {
	const files = {...initial_files};
	return {
		read_file: async (path: string, _encoding: string): Promise<string> => {
			if (!(path in files)) {
				const error: any = new Error(`ENOENT: no such file or directory, open '${path}'`);
				error.code = 'ENOENT';
				throw error;
			}
			const file_content = files[path];
			if (file_content === undefined) {
				throw new Error(`File at ${path} exists in record but has undefined content`);
			}
			return file_content;
		},
		write_file: async (path: string, content: string, _encoding: string): Promise<void> => {
			files[path] = content;
		},
		get_file: (path: string): string | undefined => files[path],
	};
};

const quote_detection_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'does not add quotes when original value contains quotes but assignment does not',
		"NAME=O'Brien",
		'NAME',
		'Smith',
		'NAME=Smith',
	],
	[
		'handles value with internal quotes when quoted',
		'NAME="O\'Brien"',
		'NAME',
		'Smith',
		'NAME="Smith"',
	],
	[
		'handles single quote style',
		"API_KEY='old_value'",
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'handles escaped quotes in value',
		'API_KEY="value with \\" escaped quotes"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles escaped quote at end of value',
		'API_KEY="test\\\\"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles multiple escaped quotes in sequence',
		'API_KEY="test\\\\\\"value"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles escaped quote with inline comment',
		'API_KEY="test\\" quote" # comment',
		'API_KEY',
		'new',
		'API_KEY="new" # comment',
	],
];

describe('update_env_variable - quote detection edge cases', () => {
	test.each(quote_detection_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});

describe('update_env_variable - special values', () => {
	test('handles empty value', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', '', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY=""');
	});

	test('handles value with equals sign', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value=with=equals', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value=with=equals"');
	});

	test('handles value with newlines', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value\nwith\nnewlines', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value\nwith\nnewlines"');
	});

	test('handles value with backslashes (Windows paths)', async () => {
		const fs = create_mock_fs({'/test/.env': 'PATH_KEY="old_path"'});

		await update_env_variable('PATH_KEY', 'C:\\Users\\Admin\\Documents', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'PATH_KEY="C:\\Users\\Admin\\Documents"');
	});

	test('handles value with unicode characters', async () => {
		const fs = create_mock_fs({'/test/.env': 'UNICODE_KEY="old"'});

		const unicode_value = '你好世界 🌍 Привет мир';
		await update_env_variable('UNICODE_KEY', unicode_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `UNICODE_KEY="${unicode_value}"`);
	});

	test('handles very long values', async () => {
		const fs = create_mock_fs({'/test/.env': 'LONG_KEY="short"'});

		const long_value = 'x'.repeat(10000);
		await update_env_variable('LONG_KEY', long_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `LONG_KEY="${long_value}"`);
	});

	test('handles value with JSON content', async () => {
		const fs = create_mock_fs({'/test/.env': 'JSON_KEY="old"'});

		const json_value = '{"name":"test","nested":{"key":"value"},"array":[1,2,3]}';
		await update_env_variable('JSON_KEY', json_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `JSON_KEY="${json_value}"`);
	});

	test('handles value with special characters', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value!@#$%^&*()_+-=[]{}|;:,.<>?', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value!@#$%^&*()_+-=[]{}|;:,.<>?"');
	});
});

const whitespace_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles key with spaces around equals sign',
		'API_KEY = "old_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'handles key with leading whitespace in file',
		'  LEADING_SPACE="old_value"',
		'LEADING_SPACE',
		'new_value',
		'LEADING_SPACE="new_value"',
	],
	[
		'handles key with trailing whitespace before equals',
		'TRAILING_SPACE  ="old_value"',
		'TRAILING_SPACE',
		'new_value',
		'TRAILING_SPACE="new_value"',
	],
];

describe('update_env_variable - whitespace handling', () => {
	test.each(whitespace_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test('preserves exact original formatting for non-matching lines', async () => {
		const fs = create_mock_fs({
			'/test/.env': '  INDENT_KEY  =  "spaced"  \nTARGET_KEY="old"\n\t\tTAB_KEY\t=\t"tabbed"\t',
		});

		await update_env_variable('TARGET_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const result = fs.get_file('/test/.env');
		assert.strictEqual(
			result,
			'  INDENT_KEY  =  "spaced"  \nTARGET_KEY="new"\n\t\tTAB_KEY\t=\t"tabbed"\t',
		);

		// Verify exact preservation of unchanged lines
		const lines = result?.split('\n') || [];
		assert.strictEqual(lines[0], '  INDENT_KEY  =  "spaced"  ');
		assert.strictEqual(lines[2], '\t\tTAB_KEY\t=\t"tabbed"\t');
	});
});

const special_key_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles key with underscores and numbers',
		'API_KEY_123="old_value"',
		'API_KEY_123',
		'new_value',
		'API_KEY_123="new_value"',
	],
	[
		'handles key with dots (regex special char)',
		'NORMAL_KEY="value1"\nSPECIAL.KEY="value2"',
		'SPECIAL.KEY',
		'new_value',
		'NORMAL_KEY="value1"\nSPECIAL.KEY="new_value"',
	],
	[
		'handles empty key name',
		'VALID_KEY="value"',
		'',
		'empty_key_value',
		'VALID_KEY="value"\n="empty_key_value"',
	],
];

describe('update_env_variable - special keys', () => {
	test.each(special_key_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});

const file_variation_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles file with only comments',
		'# Comment 1\n# Comment 2',
		'NEW_KEY',
		'new_value',
		'# Comment 1\n# Comment 2\nNEW_KEY="new_value"',
	],
	[
		'handles file with only empty lines',
		'\n\n\n',
		'NEW_KEY',
		'new_value',
		'\n\n\n\nNEW_KEY="new_value"',
	],
];

describe('update_env_variable - file variations', () => {
	test.each(file_variation_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test('verifies path is resolved to absolute', async () => {
		let resolved_path: string | undefined;

		await update_env_variable('KEY', 'value', {
			env_file_path: './relative/.env',
			read_file: async () => '',
			write_file: async (path, _content, _encoding) => {
				resolved_path = path;
			},
		});

		// Path should be absolute
		assert.ok(resolved_path);
		assert.ok(resolved_path.startsWith('/'));
		assert.ok(resolved_path.endsWith('relative/.env'));
	});
});
