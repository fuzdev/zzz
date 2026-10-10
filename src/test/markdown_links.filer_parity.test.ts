import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { FILE_INDEX_IGNORED_DIR_NAMES, FILE_INDEX_TEMP_FILE_PREFIX } from '$lib/markdown_links.ts';

/**
 * The TS copy of what the backend filer never indexes, held to the Rust
 * source it copies — a link into an ignored folder reads `skipped`, so a
 * drift would mark links there `broken`.
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

describe('the file index ignores what the backend filer ignores', () => {
	test('ignored directory names match `DEFAULT_IGNORED_DIRS` in filer.rs', () => {
		const source = read_crate_source('filer.rs');
		const match = /\bconst\s+DEFAULT_IGNORED_DIRS\s*:[^=]*=\s*&\[([^\]]*)\]\s*;/.exec(source);
		assert.ok(match, 'found `const DEFAULT_IGNORED_DIRS: &[&str] = &[…];` in filer.rs');
		const body = match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
		const entries = body
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean);
		assert.isNotEmpty(entries);
		const names = entries.map((entry) => {
			const literal = /^"([^"]*)"$/.exec(entry);
			if (literal) return literal[1]!;
			assert.match(entry, /^[A-Z_][A-Z0-9_]*$/, `an entry is a string or a constant: ${entry}`);
			return parse_str_const(source, entry);
		});
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
			read_crate_source('filer.rs'),
			'crate::scoped_fs::is_temp_file_name(name)',
			'the filer ignores staging files by that check'
		);
	});
});
