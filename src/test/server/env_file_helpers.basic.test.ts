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
	};
};

// null initial means no file exists (triggers ENOENT → create)
const basic_cases: Array<
	[label: string, initial: string | null, key: string, value: string, expected: string]
> = [
	[
		'updates existing variable with quotes',
		'API_KEY="old_value"\n',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"\n',
	],
	[
		'updates existing variable without quotes',
		'API_KEY=old_value\n',
		'API_KEY',
		'new_value',
		'API_KEY=new_value\n',
	],
	['adds new variable to empty file', '', 'NEW_KEY', 'new_value', 'NEW_KEY="new_value"'],
	[
		'adds new variable to existing file with content',
		'EXISTING_KEY="existing_value"',
		'NEW_KEY',
		'new_value',
		'EXISTING_KEY="existing_value"\nNEW_KEY="new_value"',
	],
	['creates file if it does not exist', null, 'NEW_KEY', 'new_value', 'NEW_KEY="new_value"'],
	[
		'preserves quote style for quoted variables',
		'API_KEY="old_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'preserves quote style for unquoted variables',
		'API_KEY=old_value',
		'API_KEY',
		'new_value',
		'API_KEY=new_value',
	],
];

const formatting_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'preserves comments above variables',
		'# This is a comment\nAPI_KEY="old_value"\n# Another comment',
		'API_KEY',
		'new_value',
		'# This is a comment\nAPI_KEY="new_value"\n# Another comment',
	],
	[
		'preserves empty lines',
		'API_KEY="old_value"\n\nOTHER_KEY="other_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"\n\nOTHER_KEY="other_value"',
	],
	[
		'handles file with trailing newline',
		'API_KEY="old_value"\n',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"\n',
	],
	[
		'handles file without trailing newline',
		'API_KEY="old_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
];

describe('update_env_variable - basic functionality', () => {
	test.each(basic_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs(initial !== null ? {'/test/.env': initial} : {});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});

describe('update_env_variable - formatting preservation', () => {
	test.each(formatting_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
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
