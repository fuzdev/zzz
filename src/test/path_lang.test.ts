import { test, describe, assert } from 'vitest';
import { syntax_styler_global } from '@fuzdev/fuz_code/syntax_styler_global.ts';

import { LANG_BY_EXTENSION, lang_for_path, to_path_extension } from '$lib/path_lang.ts';

describe('to_path_extension', () => {
	test('reads the last extension of the last segment, lowercased', () => {
		assert.strictEqual(to_path_extension('/w/a.ts'), 'ts');
		assert.strictEqual(to_path_extension('/w/a.b.MD'), 'md');
		assert.strictEqual(to_path_extension('a.Svelte'), 'svelte');
		assert.strictEqual(to_path_extension('/w/.bashrc'), 'bashrc');
		assert.strictEqual(to_path_extension('/w/a.'), '');
	});

	test('a name without a dot has none, whatever its directories hold', () => {
		for (const path of ['/w/Makefile', '/w.d/a', '/w/a.ts/readme', '']) {
			assert.isNull(to_path_extension(path), path);
		}
	});
});

describe('lang_for_path', () => {
	test('maps known extensions, whatever their case', () => {
		const cases: Array<[string, string]> = [
			['/w/a.ts', 'ts'],
			['/w/a.JS', 'ts'],
			['/w/a.mjs', 'ts'],
			['/w/App.svelte', 'svelte'],
			['/w/a.css', 'css'],
			['/w/package.json', 'json'],
			['/w/README.md', 'md'],
			['/w/notes.Markdown', 'md'],
			['/w/index.html', 'markup'],
			['/w/icon.svg', 'markup'],
			['/w/feed.xml', 'xml'],
			['/w/run.sh', 'sh'],
			['/w/run.bash', 'sh'],
			['/w/lib.rs', 'rust']
		];
		for (const [path, lang] of cases) {
			assert.strictEqual(lang_for_path(path), lang, path);
		}
	});

	test('unknown or missing extensions disable highlighting', () => {
		for (const path of [
			'/w/a.txt',
			'/w/a.toml',
			'/w/a.tsx',
			'/w/Makefile',
			'/w/a.',
			'/w/.env',
			''
		]) {
			assert.isNull(lang_for_path(path), path);
		}
	});

	test('every language is registered on the global syntax styler', () => {
		for (const [extension, lang] of LANG_BY_EXTENSION) {
			assert.ok(syntax_styler_global.has_lang(lang), `${extension} → ${lang}`);
		}
	});

	test('every extension key is lowercase and dotless', () => {
		for (const extension of LANG_BY_EXTENSION.keys()) {
			assert.strictEqual(extension, extension.toLowerCase());
			assert.notInclude(extension, '.');
		}
	});
});
