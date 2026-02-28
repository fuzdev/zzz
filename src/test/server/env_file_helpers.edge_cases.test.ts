// @slop Claude Sonnet 4.5

import {test, expect, describe} from 'vitest';

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

describe('update_env_variable - quote detection edge cases', () => {
	test('does not add quotes when original value contains quotes but assignment does not', async () => {
		const fs = create_mock_fs({
			'/test/.env': "NAME=O'Brien",
		});

		await update_env_variable('NAME', 'Smith', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Should preserve unquoted style
		expect(fs.get_file('/test/.env')).toBe('NAME=Smith');
	});

	test('handles value with internal quotes when quoted', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'NAME="O\'Brien"',
		});

		await update_env_variable('NAME', 'Smith', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Should preserve quoted style
		expect(fs.get_file('/test/.env')).toBe('NAME="Smith"');
	});

	test('handles single quote style', async () => {
		const fs = create_mock_fs({
			'/test/.env': "API_KEY='old_value'",
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Converts to double quotes (implementation detail)
		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"');
	});

	test('handles escaped quotes in value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="value with \\" escaped quotes"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new"');
	});

	test('handles escaped quote at end of value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="test\\\\"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new"');
	});

	test('handles multiple escaped quotes in sequence', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="test\\\\\\"value"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new"');
	});

	test('handles escaped quote with inline comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="test\\" quote" # comment',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new" # comment');
	});
});

describe('update_env_variable - special values', () => {
	test('handles empty value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', '', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY=""');
	});

	test('handles value with equals sign', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'value=with=equals', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="value=with=equals"');
	});

	test('handles value with newlines', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'value\nwith\nnewlines', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="value\nwith\nnewlines"');
	});

	test('handles value with backslashes (Windows paths)', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'PATH_KEY="old_path"',
		});

		await update_env_variable('PATH_KEY', 'C:\\Users\\Admin\\Documents', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('PATH_KEY="C:\\Users\\Admin\\Documents"');
	});

	test('handles value with unicode characters', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'UNICODE_KEY="old"',
		});

		const unicode_value = '你好世界 🌍 Привет мир';
		await update_env_variable('UNICODE_KEY', unicode_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe(`UNICODE_KEY="${unicode_value}"`);
	});

	test('handles very long values', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'LONG_KEY="short"',
		});

		const long_value = 'x'.repeat(10000);
		await update_env_variable('LONG_KEY', long_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe(`LONG_KEY="${long_value}"`);
	});

	test('handles value with JSON content', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'JSON_KEY="old"',
		});

		const json_value = '{"name":"test","nested":{"key":"value"},"array":[1,2,3]}';
		await update_env_variable('JSON_KEY', json_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe(`JSON_KEY="${json_value}"`);
	});

	test('handles value with special characters', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'value!@#$%^&*()_+-=[]{}|;:,.<>?', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="value!@#$%^&*()_+-=[]{}|;:,.<>?"');
	});
});

describe('update_env_variable - whitespace handling', () => {
	test('handles key with spaces around equals sign', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY = "old_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Normalizes to no spaces
		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"');
	});

	test('handles key with leading whitespace in file', async () => {
		const fs = create_mock_fs({
			'/test/.env': '  LEADING_SPACE="old_value"',
		});

		await update_env_variable('LEADING_SPACE', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Normalizes whitespace
		expect(fs.get_file('/test/.env')).toBe('LEADING_SPACE="new_value"');
	});

	test('handles key with trailing whitespace before equals', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'TRAILING_SPACE  ="old_value"',
		});

		await update_env_variable('TRAILING_SPACE', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('TRAILING_SPACE="new_value"');
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
		expect(result).toBe(
			'  INDENT_KEY  =  "spaced"  \nTARGET_KEY="new"\n\t\tTAB_KEY\t=\t"tabbed"\t',
		);

		// Verify exact preservation of unchanged lines
		const lines = result?.split('\n') || [];
		expect(lines[0]).toBe('  INDENT_KEY  =  "spaced"  ');
		expect(lines[2]).toBe('\t\tTAB_KEY\t=\t"tabbed"\t');
	});
});

describe('update_env_variable - special keys', () => {
	test('handles key with underscores and numbers', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY_123="old_value"',
		});

		await update_env_variable('API_KEY_123', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY_123="new_value"');
	});

	test('handles key with dots (regex special char)', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'NORMAL_KEY="value1"\nSPECIAL.KEY="value2"',
		});

		await update_env_variable('SPECIAL.KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('NORMAL_KEY="value1"\nSPECIAL.KEY="new_value"');
	});

	test('handles empty key name', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'VALID_KEY="value"',
		});

		// Empty key edge case
		await update_env_variable('', 'empty_key_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('VALID_KEY="value"\n="empty_key_value"');
	});
});

describe('update_env_variable - file variations', () => {
	test('handles file with only comments', async () => {
		const fs = create_mock_fs({
			'/test/.env': '# Comment 1\n# Comment 2',
		});

		await update_env_variable('NEW_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('# Comment 1\n# Comment 2\nNEW_KEY="new_value"');
	});

	test('handles file with only empty lines', async () => {
		const fs = create_mock_fs({
			'/test/.env': '\n\n\n',
		});

		await update_env_variable('NEW_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// File ends with newline, so blank line separator is added
		expect(fs.get_file('/test/.env')).toBe('\n\n\n\nNEW_KEY="new_value"');
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
		expect(resolved_path).toBeDefined();
		expect(resolved_path?.startsWith('/')).toBe(true);
		expect(resolved_path?.endsWith('relative/.env')).toBe(true);
	});
});
