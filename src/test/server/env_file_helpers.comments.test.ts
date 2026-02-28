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

describe('update_env_variable - inline comment preservation', () => {
	test('preserves inline comment after quoted value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value" # this is important',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value" # this is important');
	});

	test('preserves inline comment after unquoted value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY=old_value # comment here',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY=new_value # comment here');
	});

	test('preserves inline comment with no space before hash', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"# no space comment',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"# no space comment');
	});

	test('preserves inline comment with multiple spaces before hash', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"   # spaced comment',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"   # spaced comment');
	});

	test('does not treat hash inside quoted value as comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="value#with#hashes" # real comment',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value" # real comment');
	});

	test('treats hash in unquoted value as start of comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY=value#notacomment',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// The #notacomment part should be preserved as comment
		expect(fs.get_file('/test/.env')).toBe('API_KEY=new_value#notacomment');
	});

	test('handles empty inline comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value" #',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value" #');
	});

	test('preserves inline comment with special characters', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old" # TODO: update this! @important',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new" # TODO: update this! @important');
	});

	test('handles single quotes with inline comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': "API_KEY='old_value' # comment",
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// Should preserve quotes and comment
		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value" # comment');
	});

	test('does not add inline comment when original has none', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new_value"');
	});

	test('preserves multiple hashes in comment', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old" # comment ## with ### hashes',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('API_KEY="new" # comment ## with ### hashes');
	});

	test('preserves comment after escaped backslash at end of value', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="test\\\\" # important comment',
		});

		await update_env_variable('API_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// The \\\\ is two backslashes (one escaped), then closing quote, then comment
		expect(fs.get_file('/test/.env')).toBe('API_KEY="new" # important comment');
	});

	test('preserves comment after single escaped backslash', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'PATH="C:\\\\temp\\\\" # Windows path',
		});

		await update_env_variable('PATH', 'D:\\\\new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		expect(fs.get_file('/test/.env')).toBe('PATH="D:\\\\new" # Windows path');
	});

	test('handles escaped quote followed by more content (not a closing quote)', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'MSG="Say \\"hello\\" please" # greeting',
		});

		await update_env_variable('MSG', 'new message', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// The \" are escaped quotes, final " is closing quote
		expect(fs.get_file('/test/.env')).toBe('MSG="new message" # greeting');
	});
});
