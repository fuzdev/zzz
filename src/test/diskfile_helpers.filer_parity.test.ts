import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	ERROR_DISK_CHANGED,
	ERROR_INVALID_PATH,
	ERROR_PATH_NOT_FOUND,
	FILE_INDEX_IGNORED_DIR_NAMES,
	FILE_INDEX_TEMP_FILE_PREFIX
} from '#lib/diskfile_helpers.ts';

/**
 * The TS copy of what the backend filer never indexes, held to the Rust
 * source it copies — a link into an ignored folder reads `skipped` and the
 * file tree hides one, so a drift would mark links there `broken` or show or
 * hide the wrong folders.
 */

const read_crate_source = (name: string): string =>
	readFileSync(new URL(`../../crates/zzz_server/src/${name}`, import.meta.url), 'utf8');

/** The string value of `const NAME: &str = "…";` in `source`, failing loudly when it's not found. */
const parse_str_const = (source: string, name: string): string => {
	const match = new RegExp(
		String.raw`\bconst\s+${name}\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]*)"\s*;`
	).exec(source);
	assert.ok(match, `found \`const ${name}: &str\``);
	return match[1]!;
};

/**
 * The entries of `const NAME: &[&str] = &[…];` in `source`, each a string
 * literal or a `&str` constant of `source`, failing loudly when it's not found.
 */
const parse_str_list_const = (source: string, name: string): Array<string> => {
	const match = new RegExp(String.raw`\bconst\s+${name}\s*:[^=]*=\s*&\[([^\]]*)\]\s*;`).exec(
		source
	);
	assert.ok(match, `found \`const ${name}: &[&str] = &[…];\``);
	const body = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	const entries = body
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	assert.isNotEmpty(entries);
	return entries.map((entry) => {
		const literal = /^"([^"]*)"$/.exec(entry);
		if (literal) return literal[1]!;
		assert.match(entry, /^[A-Z_][A-Z0-9_]*$/, `an entry is a string or a constant: ${entry}`);
		return parse_str_const(source, entry);
	});
};

describe('the file index ignores what the backend filer ignores', () => {
	test("ignored directory names match the names a plain root's filer ignores", () => {
		const filer = read_crate_source('filer/ignore.rs');
		const scoped_fs = read_crate_source('scoped_fs.rs');
		// a constant is the filer's own or one it imports from `scoped_fs.rs`;
		// a plain root ignores both of the filer's lists
		const names = [
			...parse_str_list_const(`${filer}\n${scoped_fs}`, 'ALWAYS_IGNORED_DIRS'),
			...parse_str_list_const(`${filer}\n${scoped_fs}`, 'PLAIN_DIR_IGNORED_DIRS'),
			...parse_str_list_const(scoped_fs, 'CREDENTIAL_DIR_NAMES')
		];
		assert.match(
			scoped_fs,
			/fn\s+is_credential_dir_name\s*\([^)]*\)\s*->\s*bool\s*\{\s*CREDENTIAL_DIR_NAMES\.contains\(&name\)\s*\}/,
			'`is_credential_dir_name` is a plain membership check, as the TS side assumes'
		);
		assert.include(
			filer,
			'crate::scoped_fs::is_credential_dir_name(name)',
			'the filer ignores credential directories by that check'
		);
		assert.deepEqual([...FILE_INDEX_IGNORED_DIR_NAMES].sort(), names.sort());
	});

	test('the staging-file prefix matches `TEMP_FILE_PREFIX` in scoped_fs.rs', () => {
		const source = read_crate_source('scoped_fs.rs');
		assert.strictEqual(FILE_INDEX_TEMP_FILE_PREFIX, parse_str_const(source, 'TEMP_FILE_PREFIX'));
		assert.match(
			source,
			/fn\s+is_temp_file_name\s*\([^)]*\)\s*->\s*bool\s*\{\s*name\.starts_with\(TEMP_FILE_PREFIX\)\s*\}/,
			'`is_temp_file_name` is a plain prefix check, as the TS side assumes'
		);
		assert.include(
			read_crate_source('filer/ignore.rs'),
			'crate::scoped_fs::is_temp_file_name(name)',
			'the filer ignores staging files by that check'
		);
	});

	test('the file errors the frontend reads by reason match `handlers/filesystem.rs`', () => {
		const source = read_crate_source('handlers/filesystem.rs');
		assert.strictEqual(ERROR_INVALID_PATH, parse_str_const(source, 'ERROR_INVALID_PATH'));
		assert.strictEqual(ERROR_PATH_NOT_FOUND, parse_str_const(source, 'ERROR_PATH_NOT_FOUND'));
		assert.strictEqual(ERROR_DISK_CHANGED, parse_str_const(source, 'ERROR_DISK_CHANGED'));
	});
});
