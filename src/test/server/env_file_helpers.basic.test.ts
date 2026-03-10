import {test, describe, assert} from 'vitest';

import {update_env_variable} from '$lib/server/env_file_helpers.js';

/**
 * Creates an in-memory file system for testing.
 * No module-level mocks - uses dependency injection instead.
 */
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
		get_all_files: (): Record<string, string> => ({...files}),
	};
};

describe('update_env_variable - basic functionality', () => {
	test('updates existing variable with quotes', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"\n',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="new_value"\n');
	});

	test('updates existing variable without quotes', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY=old_value\n',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY=new_value\n');
	});

	test('adds new variable to empty file', async () => {
		const fs = create_mock_fs({
			'/test/.env': '',
		});

		await update_env_variable('NEW_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'NEW_KEY="new_value"');
	});

	test('adds new variable to existing file with content', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'EXISTING_KEY="existing_value"',
		});

		await update_env_variable('NEW_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'EXISTING_KEY="existing_value"\nNEW_KEY="new_value"');
	});

	test('creates file if it does not exist', async () => {
		const fs = create_mock_fs({});

		await update_env_variable('NEW_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'NEW_KEY="new_value"');
	});

	test('preserves quote style for quoted variables', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="new_value"');
	});

	test('preserves quote style for unquoted variables', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY=old_value',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY=new_value');
	});
});

describe('update_env_variable - formatting preservation', () => {
	test('preserves comments above variables', async () => {
		const fs = create_mock_fs({
			'/test/.env': '# This is a comment\nAPI_KEY="old_value"\n# Another comment',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'),
			'# This is a comment\nAPI_KEY="new_value"\n# Another comment',
		);
	});

	test('preserves empty lines', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"\n\nOTHER_KEY="other_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="new_value"\n\nOTHER_KEY="other_value"');
	});

	test('handles file with trailing newline', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"\n',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="new_value"\n');
	});

	test('handles file without trailing newline', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'API_KEY="old_value"',
		});

		await update_env_variable('API_KEY', 'new_value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="new_value"');
	});
});

describe('update_env_variable - error handling', () => {
	test('propagates read file error', async () => {
		const error_message = 'Permission denied';
		const custom_read = async (): Promise<string> => {
			throw new Error(error_message);
		};

		try {
			await update_env_variable('API_KEY', 'new_value', {
				env_file_path: '/test/.env',
				read_file: custom_read,
				write_file: async () => {},
			});
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, error_message);
		}
	});

	test('propagates write file error', async () => {
		const error_message = 'Disk full';
		const custom_write = async (): Promise<void> => {
			throw new Error(error_message);
		};

		try {
			await update_env_variable('API_KEY', 'new_value', {
				env_file_path: '/test/.env',
				read_file: async () => '',
				write_file: custom_write,
			});
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, error_message);
		}
	});
});
