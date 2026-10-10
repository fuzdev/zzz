import { describe, test, assert } from 'vitest';
import { mdz_parse } from '@fuzdev/mdz/mdz.ts';

import {
	resolve_markdown_link,
	to_directory_readme_path,
	to_markdown_headings,
	to_markdown_link_mark,
	to_markdown_link_status,
	to_markdown_link_title,
	to_markdown_links,
	to_root_dir,
	type MarkdownLinkIndex,
	type MarkdownLinkTarget
} from '$lib/markdown_links.ts';

const FILE = '/w/docs/guide.md';
const OPTIONS = { file_path: FILE, root_dir: '/w/' };

const path_target = (
	path: string,
	extra: Partial<Extract<MarkdownLinkTarget, { kind: 'path' }>> = {}
): MarkdownLinkTarget => ({
	kind: 'path',
	path,
	directory: false,
	fragment: null,
	root_relative: false,
	...extra
});

describe('resolve_markdown_link', () => {
	const cases: Array<[href: string, expected: MarkdownLinkTarget]> = [
		['./x.md', path_target('/w/docs/x.md')],
		['x.md', path_target('/w/docs/x.md')],
		['../README.md', path_target('/w/README.md')],
		['./a/../b/./c.md', path_target('/w/docs/b/c.md')],
		['a//b.md', path_target('/w/docs/a/b.md')],
		['X.MD', path_target('/w/docs/X.MD')],
		['sub/', path_target('/w/docs/sub/', { directory: true })],
		['sub', path_target('/w/docs/sub')],
		['.', path_target('/w/docs/', { directory: true })],
		['./', path_target('/w/docs/', { directory: true })],
		['..', path_target('/w/', { directory: true })],
		['../..', path_target('/', { directory: true })],
		['a%20b.md', path_target('/w/docs/a b.md')],
		['x.md?plain=1', path_target('/w/docs/x.md')],
		['x.md#Some%20Heading', path_target('/w/docs/x.md', { fragment: 'Some Heading' })],
		['x.md?q=1#frag', path_target('/w/docs/x.md', { fragment: 'frag' })],
		['x.md#', path_target('/w/docs/x.md')],
		['/src/a.md', path_target('/w/src/a.md', { root_relative: true })],
		['/', path_target('/w/', { directory: true, root_relative: true })],
		['#later', { kind: 'fragment', fragment: 'later' }],
		['#a%20b', { kind: 'fragment', fragment: 'a b' }],
		['#a%zz', { kind: 'fragment', fragment: 'a%zz' }],
		['https://example.com/x', { kind: 'external', href: 'https://example.com/x' }],
		['HTTP://example.com', { kind: 'external', href: 'HTTP://example.com' }],
		['', { kind: 'inert' }],
		['#', { kind: 'inert' }],
		['?q=1', { kind: 'inert' }],
		['?q#frag', { kind: 'inert' }],
		['mailto:a@b.c', { kind: 'inert' }],
		// eslint-disable-next-line no-script-url
		['javascript:alert(1)', { kind: 'inert' }],
		['//evil.example/x', { kind: 'inert' }],
		['a\\b.md', { kind: 'inert' }],
		['../../../x.md', { kind: 'inert' }],
		['/../x.md', { kind: 'inert' }],
		['a%2Fb.md', { kind: 'inert' }],
		['a%00.md', { kind: 'inert' }],
		['a%zz.md', { kind: 'inert' }]
	];
	for (const [href, expected] of cases) {
		test(JSON.stringify(href), () => {
			assert.deepEqual(resolve_markdown_link(href, OPTIONS), expected);
		});
	}

	test('without a file, path links are inert, and fragments and external links still resolve', () => {
		assert.deepEqual(resolve_markdown_link('./x.md'), { kind: 'inert' });
		assert.deepEqual(resolve_markdown_link('/x.md', { file_path: null }), { kind: 'inert' });
		assert.deepEqual(resolve_markdown_link('#a'), { kind: 'fragment', fragment: 'a' });
		assert.strictEqual(resolve_markdown_link('https://x.dev').kind, 'external');
	});

	test('without a root, root-relative links are inert and relative ones resolve', () => {
		assert.deepEqual(resolve_markdown_link('/x.md', { file_path: FILE }), { kind: 'inert' });
		assert.deepEqual(
			resolve_markdown_link('x.md', { file_path: FILE }),
			path_target('/w/docs/x.md')
		);
	});

	test('a file at the filesystem root resolves beside it', () => {
		assert.deepEqual(resolve_markdown_link('x.md', { file_path: '/a.md' }), path_target('/x.md'));
		assert.deepEqual(resolve_markdown_link('../x.md', { file_path: '/a.md' }), { kind: 'inert' });
	});
});

describe('to_root_dir', () => {
	test('picks the innermost root holding the path', () => {
		assert.strictEqual(to_root_dir('/w/a/b.md', ['/w/', '/w/a/', '/x/']), '/w/a/');
		assert.strictEqual(to_root_dir('/w/b.md', ['/w/a/', '/w/']), '/w/');
	});

	test('a sibling sharing a prefix is no root', () => {
		assert.isNull(to_root_dir('/work/b.md', ['/w/']));
	});
});

const create_index = (files: Array<string>, roots: Array<string> = ['/w/']): MarkdownLinkIndex => {
	const file_set = new Set(files);
	return {
		has_file: (path) => file_set.has(path),
		has_directory: (path) => files.some((f) => f.startsWith(path)),
		roots
	};
};

describe('to_markdown_link_status', () => {
	const index = create_index(['/w/docs/x.md', '/w/docs/sub/README.md']);
	const status = (href: string): string => {
		const target = resolve_markdown_link(href, OPTIONS);
		assert.strictEqual(target.kind, 'path');
		return to_markdown_link_status(target as Extract<MarkdownLinkTarget, { kind: 'path' }>, index);
	};

	test('an indexed file', () => {
		assert.strictEqual(status('./x.md'), 'file');
	});

	test('a folder holding indexed files, with or without a trailing slash', () => {
		assert.strictEqual(status('sub/'), 'directory');
		assert.strictEqual(status('sub'), 'directory');
		assert.strictEqual(status('..'), 'directory');
	});

	test('a file named with a trailing slash is no folder', () => {
		assert.strictEqual(status('x.md/'), 'broken');
	});

	test('missing inside a root is broken', () => {
		assert.strictEqual(status('./missing.md'), 'broken');
		assert.strictEqual(status('./X.MD'), 'broken', 'case-sensitive');
	});

	test('outside every root is never broken', () => {
		assert.strictEqual(status('../../elsewhere.md'), 'outside');
	});

	test('inside a folder the index skips is never broken', () => {
		assert.strictEqual(status('../node_modules/pkg/README.md'), 'skipped');
		assert.strictEqual(status('../.git/config'), 'skipped');
		assert.strictEqual(status('./target/'), 'skipped');
		assert.strictEqual(status('./.zzz-tmp-abc'), 'skipped');
	});

	test('a skipped name above the root is no reason to doubt', () => {
		const deep = create_index([], ['/home/u/dist/w/']);
		const target = resolve_markdown_link('./missing.md', { file_path: '/home/u/dist/w/a.md' });
		assert.strictEqual(
			to_markdown_link_status(target as Extract<MarkdownLinkTarget, { kind: 'path' }>, deep),
			'broken'
		);
	});

	test('a root-relative miss is unconfirmed, a hit is found', () => {
		assert.strictEqual(status('/nope.md'), 'root_relative');
		assert.strictEqual(status('/docs/x.md'), 'file');
	});
});

describe('to_markdown_link_mark', () => {
	test('broken is marked broken, what the index can not see unknown, the rest unmarked', () => {
		assert.strictEqual(to_markdown_link_mark('broken'), 'broken');
		for (const status of ['outside', 'skipped', 'root_relative'] as const) {
			assert.strictEqual(to_markdown_link_mark(status), 'unknown');
		}
		for (const status of ['file', 'directory', null] as const) {
			assert.isNull(to_markdown_link_mark(status));
		}
	});
});

describe('to_directory_readme_path', () => {
	test('finds a README, first name first', () => {
		const index = create_index(['/w/a/readme.md', '/w/a/README.md', '/w/b/Readme.md']);
		assert.strictEqual(to_directory_readme_path('/w/a/', index), '/w/a/README.md');
		assert.strictEqual(to_directory_readme_path('/w/b/', index), '/w/b/Readme.md');
		assert.isNull(to_directory_readme_path('/w/c/', index));
	});
});

describe('to_markdown_headings', () => {
	test('lists headings in order with their level, id, text, and offset', () => {
		const source = '# Title\n\ntext\n\n## Sub **bold** `code`\n\n> ### quoted\n';
		const headings = to_markdown_headings(mdz_parse(source));
		assert.deepEqual(
			headings.map(({ level, text }) => [level, text]),
			[
				[1, 'Title'],
				[2, 'Sub bold code'],
				[3, 'quoted']
			]
		);
		assert.strictEqual(headings[0]!.id, 'title');
		assert.strictEqual(source.slice(headings[1]!.start, headings[1]!.start + 6), '## Sub');
	});

	test('a document without headings has none', () => {
		assert.deepEqual(to_markdown_headings(mdz_parse('just text')), []);
	});
});

describe('to_markdown_links', () => {
	test('lists rendered links in order, resolved and checked', () => {
		const source = 'see [x](./x.md), [gone](./gone.md), ./bare.md, and [web](https://example.com)';
		const links = to_markdown_links(mdz_parse(source), {
			file_path: FILE,
			index: create_index(['/w/docs/x.md'])
		});
		assert.deepEqual(
			links.map(({ reference, text, status }) => [reference, text, status]),
			[
				['./x.md', 'x', 'file'],
				['./gone.md', 'gone', 'broken'],
				['./bare.md', './bare.md', 'broken'],
				['https://example.com', 'web', null]
			]
		);
		assert.strictEqual(source.slice(links[1]!.start, links[1]!.start + 6), '[gone]');
	});

	test('without an index nothing is checked; without a file paths are inert', () => {
		const nodes = mdz_parse('[x](./x.md)');
		assert.isNull(to_markdown_links(nodes, { file_path: FILE })[0]!.status);
		assert.deepEqual(to_markdown_links(nodes)[0]!.target, { kind: 'inert' });
	});

	test('root-relative links resolve against the innermost root holding the file', () => {
		const links = to_markdown_links(mdz_parse('[a](/src/a.md)'), {
			file_path: '/w/repo/docs/guide.md',
			index: create_index(['/w/repo/src/a.md'], ['/w/', '/w/repo/'])
		});
		assert.strictEqual(links[0]!.status, 'file');
	});

	test('a table cell past the column count is skipped, as the renderer drops it', () => {
		const source = '| a |\n| - |\n| [in](./in.md) | [out](./out.md) |\n';
		const links = to_markdown_links(mdz_parse(source), { file_path: FILE });
		assert.deepEqual(
			links.map((l) => l.reference),
			['./in.md']
		);
	});
});

describe('to_markdown_link_title', () => {
	const index = create_index(['/w/docs/sub/README.md', '/w/docs/empty/x.txt']);
	const titles = (source: string): Array<string | null> =>
		to_markdown_links(mdz_parse(source), { file_path: FILE, index }).map((link) =>
			to_markdown_link_title(
				link,
				link.status === 'directory' && link.target.kind === 'path'
					? to_directory_readme_path(link.target.path, index)
					: null
			)
		);

	test('says why a link is marked, and what a folder link does', () => {
		assert.deepEqual(
			titles(
				'[a](./gone.md) [b](../../far.md) [c](./node_modules/x) [d](/nope.md) [e](sub/) [f](empty/) [g](https://x.dev)'
			),
			[
				'not found: /w/docs/gone.md',
				'outside the open workspaces: /far.md',
				'in a folder the file index skips: /w/docs/node_modules/x',
				'not found from the workspace root: /w/nope.md',
				"opens the folder's readme: /w/docs/sub/README.md",
				'a folder, which zzz has no view for: /w/docs/empty/',
				null
			]
		);
	});
});
