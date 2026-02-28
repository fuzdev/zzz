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

describe('update_env_variable - duplicate keys (LAST wins behavior)', () => {
	test('updates LAST occurrence when key appears twice', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="first_value"\nAPI_KEY="second_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// First occurrence stays unchanged, second (last) is updated
		expect(fs.get_file('/test/.env')).toBe('API_KEY="first_value"\nAPI_KEY="new_value"');
	});

	test('updates LAST occurrence when key appears three times', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'KEY="first"\nKEY="second"\nKEY="third"',
		});

		await update_env_variable('KEY', 'updated', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const result = fs.get_file('/test/.env');
		expect(result).toBe('KEY="first"\nKEY="second"\nKEY="updated"');

		// Verify first two occurrences are unchanged
		const lines = result?.split('\n') || [];
		expect(lines[0]).toBe('KEY="first"');
		expect(lines[1]).toBe('KEY="second"');
		expect(lines[2]).toBe('KEY="updated"');
	});

	test('matches dotenv behavior: last wins', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY=first_value\nAPI_KEY=second_value\nAPI_KEY=third_value',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// dotenv would use "third_value", so we update the third occurrence
		const result = fs.get_file('/test/.env');
		expect(result).toBe('API_KEY=first_value\nAPI_KEY=second_value\nAPI_KEY=new_value');
	});

	test('updates LAST occurrence with inline comments preserved', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'KEY="first" # dev\nKEY="second" # prod',
		});

		await update_env_variable('KEY', 'updated', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('KEY="first" # dev\nKEY="updated" # prod');
	});

	test('updates LAST occurrence when duplicates have different quote styles', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'KEY=unquoted_first\nKEY="quoted_second"',
		});

		await update_env_variable('KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// First stays unquoted, second (last) is updated and stays quoted
		expect(fs.get_file('/test/.env')).toBe('KEY=unquoted_first\nKEY="new"');
	});

	test('updates LAST occurrence when separated by other keys', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="first"\nOTHER_KEY="value"\nAPI_KEY="second"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="first"\nOTHER_KEY="value"\nAPI_KEY="new"');
	});

	test('updates LAST occurrence when separated by comments', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="first"\n# Comment\nAPI_KEY="second"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="first"\n# Comment\nAPI_KEY="new"');
	});

	test('updates LAST occurrence when separated by empty lines', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="first"\n\nAPI_KEY="second"',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="first"\n\nAPI_KEY="new"');
	});

	test('handles keys that are substrings of each other', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'KEY="value1"\nSECRET_KEY="value2"',
		});

		await update_env_variable('KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Should only update KEY, not SECRET_KEY
		expect(fs.get_file('/test/.env')).toBe('KEY="new_value"\nSECRET_KEY="value2"');
	});

	test('handles keys that are prefixes of each other', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="value1"\nAPI_KEY_SECRET="value2"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Should only update API_KEY, not API_KEY_SECRET
		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"\nAPI_KEY_SECRET="value2"');
	});

	test('does not match keys in comments', async () => {
		const fs = create_mock_fs({
			'/test/.env': '# API_KEY="commented"\nAPI_KEY="actual_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Comment line should be unchanged
		expect(fs.get_file('/test/.env')).toBe('# API_KEY="commented"\nAPI_KEY="new_value"');
	});
});
