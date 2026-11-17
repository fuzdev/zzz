/**
 * Links and headings in rendered markdown, for `MarkdownPreview` and the
 * markdown view's drawer — pure functions over mdz's parsed nodes, with no
 * app state, plus the one DOM query matching links to their rendered anchors
 * by their source offsets.
 *
 * A link in a file resolves against the file's path, the way a repository
 * host reads it: `./x.md`, `../y/z.md`, and `x.md` against the file's
 * directory, and a root-relative `/docs/x.md` against the innermost indexed
 * directory holding the file (a focused repo, or a checkout's or directory's
 * root — usually the repository). Whether the result exists is the file index's call
 * (`MarkdownLinkIndex`), and what the index can't see is `unknown`, never
 * `broken`.
 *
 * @module
 */

import type { MdzNode, MdzNodeHeading } from '@fuzdev/mdz/mdz.ts';
import { mdz_is_safe_reference } from '@fuzdev/mdz/mdz_helpers.ts';

import {
	to_innermost_unindexed_part,
	type FileIndexIgnoreRule,
	type FileIndexUnindexedPart
} from './diskfile_helpers.ts';

/**
 * Where a link in a markdown file leads:
 *
 * - `external` — an `http:` or `https:` URL, left to the browser
 * - `fragment` — a heading in the same document (`#id`, decoded)
 * - `path` — an absolute path on disk, with `directory` when the link names
 *   a folder (a trailing `/`, or a last segment of `.` or `..`), its decoded
 *   `#fragment` if any, and `root_relative` when it was written `/…`
 * - `inert` — nothing to follow: empty, query-only, another scheme,
 *   protocol-relative, malformed, climbing past its root, or relative with
 *   no file to resolve against
 */
export type MarkdownLinkTarget =
	| { kind: 'external'; href: string }
	| { kind: 'fragment'; fragment: string }
	| {
			kind: 'path';
			path: string;
			directory: boolean;
			fragment: string | null;
			root_relative: boolean;
	  }
	| { kind: 'inert' };

export interface ResolveMarkdownLinkOptions {
	/** The absolute path of the file the link is in — without it, every path link is `inert`. */
	file_path?: string | null | undefined;
	/**
	 * The directory (with a trailing `/`) a root-relative link resolves
	 * against — see `to_root_dir`. Without it, root-relative links are `inert`.
	 */
	root_dir?: string | null | undefined;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/** Decodes a percent-escaped string, or `null` when an escape is malformed. */
const decode = (value: string): string | null => {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
};

/**
 * Resolves `href`, a link's reference in a markdown file, to where it leads
 * (see `MarkdownLinkTarget`). A path link drops its `?query`, keeps its
 * `#fragment`, has each segment percent-decoded, and is normalized: `.` and
 * empty segments vanish and `..` climbs, but never above `/` — or above
 * `root_dir` for a root-relative link — which makes it `inert`. An escape
 * that decodes to `/` or a NUL is `inert` too, since it would change the
 * path's shape.
 *
 * @param href - the link's reference as written (an `<a>`'s `href` attribute)
 * @param options - the file the link is in, and the root a root-relative link resolves against
 */
export const resolve_markdown_link = (
	href: string,
	options: ResolveMarkdownLinkOptions = {}
): MarkdownLinkTarget => {
	if (!href) return { kind: 'inert' };

	if (href.startsWith('#')) {
		// a malformed escape matches no heading as written, so look for it raw
		const fragment = decode(href.slice(1)) ?? href.slice(1);
		return fragment ? { kind: 'fragment', fragment } : { kind: 'inert' };
	}

	if (SCHEME_PATTERN.test(href)) {
		return /^https?:/i.test(href) ? { kind: 'external', href } : { kind: 'inert' };
	}

	// protocol-relative (`//host/x`) and backslashed references read differently by browser and
	// repository host, so they're not followed
	if (href.startsWith('//') || href.includes('\\')) return { kind: 'inert' };

	const hash_index = href.indexOf('#');
	const before_hash = hash_index === -1 ? href : href.slice(0, hash_index);
	const query_index = before_hash.indexOf('?');
	const path_part = query_index === -1 ? before_hash : before_hash.slice(0, query_index);
	if (!path_part) return { kind: 'inert' };

	let fragment: string | null = null;
	if (hash_index !== -1) {
		const raw = href.slice(hash_index + 1);
		fragment = (decode(raw) ?? raw) || null;
	}

	const { file_path, root_dir } = options;
	if (!file_path) return { kind: 'inert' };

	const root_relative = path_part.startsWith('/');
	let base: string;
	if (root_relative) {
		if (!root_dir) return { kind: 'inert' };
		base = root_dir;
	} else {
		base = file_path.slice(0, file_path.lastIndexOf('/') + 1);
	}

	const stack = base.split('/').filter(Boolean);
	const floor = root_relative ? stack.length : 0;
	const segments = path_part.split('/');
	for (const raw of segments) {
		const segment = decode(raw);
		if (segment === null || segment.includes('/') || segment.includes('\0')) {
			return { kind: 'inert' };
		}
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (stack.length <= floor) return { kind: 'inert' };
			stack.pop();
		} else {
			stack.push(segment);
		}
	}

	const last = segments.at(-1);
	const directory = last === '' || last === '.' || last === '..';
	const joined = '/' + stack.join('/');
	const path = directory && stack.length ? joined + '/' : joined;
	return { kind: 'path', path, directory, fragment, root_relative };
};

/**
 * The innermost of `roots` (directories with a trailing `/`) holding `path`,
 * or `null` when none does — the directory a root-relative link in the file
 * at `path` resolves against.
 *
 * @param path - an absolute path
 * @param roots - the open directories, each with a trailing `/`
 */
export const to_root_dir = (path: string, roots: ReadonlyArray<string>): string | null => {
	let found: string | null = null;
	for (const root of roots) {
		if (path.startsWith(root) && (found === null || root.length > found.length)) found = root;
	}
	return found;
};

/**
 * What the file index knows — the files and folders under its roots — for
 * telling a link's target exists, is missing, or is out of sight.
 */
export interface MarkdownLinkIndex {
	/** Whether a file is indexed at `path`. */
	has_file: (path: string) => boolean;
	/** Whether an indexed file sits somewhere under `path`, a directory with a trailing `/`. */
	has_directory: (path: string) => boolean;
	/**
	 * The directories whose whole trees the index covers, each with a trailing
	 * `/`: the app directory, the scoped dirs, a checkout's or plain
	 * directory's root, and a registry project's focused repos.
	 */
	readonly roots: ReadonlyArray<string>;
	/**
	 * The directories the index covers at their top level alone, each with a
	 * trailing `/` — a registry project's root, whose loose files are indexed
	 * and whose unfocused repos aren't.
	 */
	readonly top_level_roots: ReadonlyArray<string>;
	/**
	 * A registry project's entry dirs that aren't focused, each with a
	 * trailing `/` — named by the registry, so a link to one reads as out of
	 * sight even without a trailing slash, where it would otherwise look like
	 * a missing loose file.
	 */
	readonly unfocused_dirs: ReadonlyArray<string>;
	/**
	 * The rule of each root in `roots` the daemon indexes by git's answer, by
	 * root; every other root is on fixed names (`FileIndexIgnoreRule`).
	 */
	readonly ignore_rules: ReadonlyMap<string, FileIndexIgnoreRule>;
}

/**
 * How a path link stands against the file index:
 *
 * - `file` / `directory` — it names an indexed file, or a folder holding one
 * - `broken` — it's inside a root the index covers, where the index would
 *   list it, yet nothing is there
 * - the index can't say (see `MarkdownLinkMark`'s `unknown`):
 *   - `outside` — outside every root the index covers
 *   - `unfocused` — under a registry project's root, below its top level and
 *     in no focused repo, where the index doesn't look
 *   - `skipped` — a path part no filer holding it enters or lists, by its
 *     name, because git ignores it, or as a repo of its own nested in a git
 *     root (`to_innermost_unindexed_part`, `MarkdownLink.unindexed`) —
 *     shown as not indexed
 *   - `root_relative` — written `/…` and not found from the project's
 *     root, which may not be the repository's
 */
export type MarkdownLinkStatus =
	'file' | 'directory' | 'broken' | 'outside' | 'unfocused' | 'skipped' | 'root_relative';

/**
 * Checks a path link's target against the file index (see
 * `MarkdownLinkStatus`). A folder holding no indexed file — say an empty
 * one — reads as missing, since the index lists only files.
 *
 * @param target - a resolved path link
 * @param index - what the file index knows
 */
export const to_markdown_link_status = (
	target: Extract<MarkdownLinkTarget, { kind: 'path' }>,
	index: MarkdownLinkIndex
): MarkdownLinkStatus => check_markdown_link(target, index).status;

/** A path link's status, and for a `skipped` one the part the index skips. */
const check_markdown_link = (
	target: Extract<MarkdownLinkTarget, { kind: 'path' }>,
	index: MarkdownLinkIndex
): { status: MarkdownLinkStatus; unindexed: FileIndexUnindexedPart | null } => {
	const found = (status: MarkdownLinkStatus) => ({ status, unindexed: null });
	const { path } = target;
	if (!target.directory && index.has_file(path)) return found('file');
	const dir_path = path.endsWith('/') ? path : path + '/';
	if (index.has_directory(dir_path)) return found('directory');
	if (target.root_relative) return found('root_relative');
	if (to_root_dir(dir_path, index.roots) === null) {
		const top = to_root_dir(dir_path, index.top_level_roots);
		if (top === null) return found('outside');
		if (index.unfocused_dirs.some((dir) => dir_path.startsWith(dir))) return found('unfocused');
		// only a file directly in a top-level root is where the index looks
		// TODO an unregistered directory linked without a trailing slash
		// (`./scratch`) reads as a missing loose file, so broken: the honest fix
		// is for the top-level filer to report the root's child directory names,
		// a wire change
		const name = path.slice(top.length);
		if (target.directory || name.includes('/')) return found('unfocused');
	}
	// skipped only where every filer holding it skips it; a link without a
	// trailing slash may name a file or a folder, which git's paths tell apart
	const unindexed_part = (p: string) =>
		to_innermost_unindexed_part(p, index.roots, index.top_level_roots, index.ignore_rules);
	const unindexed = unindexed_part(dir_path) ?? (target.directory ? null : unindexed_part(path));
	return unindexed ? { status: 'skipped', unindexed } : found('broken');
};

/**
 * How the preview marks a link: `broken` when the index says its target is
 * missing, `unknown` when the index can't see where it points.
 */
export type MarkdownLinkMark = 'broken' | 'unknown';

/**
 * The mark for a link with `status`, or `null` for one that needs none.
 *
 * @param status - the link's status, `null` when it wasn't checked
 */
export const to_markdown_link_mark = (
	status: MarkdownLinkStatus | null
): MarkdownLinkMark | null => {
	switch (status) {
		case 'broken':
			return 'broken';
		case 'outside':
		case 'unfocused':
		case 'skipped':
		case 'root_relative':
			return 'unknown';
		default:
			return null;
	}
};

/** The names a folder link opens, first found wins — a repository host shows the README. */
export const MARKDOWN_DIRECTORY_INDEX_NAMES: ReadonlyArray<string> = [
	'README.md',
	'readme.md',
	'Readme.md'
];

/**
 * The README a link to the folder at `dir_path` opens, or `null` when the
 * index has none there (see `MARKDOWN_DIRECTORY_INDEX_NAMES`).
 *
 * @param dir_path - the folder, with a trailing `/`
 * @param index - what the file index knows
 */
export const to_directory_readme_path = (
	dir_path: string,
	index: MarkdownLinkIndex
): string | null => {
	for (const name of MARKDOWN_DIRECTORY_INDEX_NAMES) {
		const path = dir_path + name;
		if (index.has_file(path)) return path;
	}
	return null;
};

/**
 * Calls `visit` on each node mdz renders, in document order — the order of
 * the rendered elements. A table's cells past its column count are skipped,
 * as the renderer drops them.
 */
const walk_rendered = (nodes: ReadonlyArray<MdzNode>, visit: (node: MdzNode) => void): void => {
	for (const node of nodes) {
		visit(node);
		if (node.type === 'Table') {
			const columns = node.align.length;
			for (const row of node.children) {
				walk_rendered(row.children.slice(0, columns), visit);
			}
		} else if ('children' in node) {
			walk_rendered(node.children, visit);
		}
	}
};

/** The plain text of `nodes`, formatting dropped. */
export const to_mdz_plain_text = (nodes: ReadonlyArray<MdzNode>): string => {
	let text = '';
	for (const node of nodes) {
		if (node.type === 'Text' || node.type === 'Code' || node.type === 'Codeblock') {
			text += node.content;
		} else if ('children' in node) {
			text += to_mdz_plain_text(node.children);
		}
	}
	return text;
};

/** A heading in a markdown document, for an outline. */
export interface MarkdownHeading {
	level: MdzNodeHeading['level'];
	/** The slug a `#fragment` names it by — `''` when its text has none. */
	id: string;
	text: string;
	/** Where its source starts, a UTF-16 offset into the document. */
	start: number;
}

/**
 * The document's headings in rendered order, those in blockquotes included —
 * the `i`th is the preview's `i`th `h1`–`h6`.
 *
 * @param nodes - the document, parsed by `mdz_parse`
 */
export const to_markdown_headings = (nodes: ReadonlyArray<MdzNode>): Array<MarkdownHeading> => {
	const headings: Array<MarkdownHeading> = [];
	walk_rendered(nodes, (node) => {
		if (node.type === 'Heading') {
			headings.push({
				level: node.level,
				id: node.id,
				text: to_mdz_plain_text(node.children).trim(),
				start: node.start
			});
		}
	});
	return headings;
};

/** A link in a markdown document, resolved. */
export interface MarkdownLink {
	/**
	 * The reference as written — the rendered `<a>`'s `href`, except where mdz
	 * collapses a leading slash run (see `query_markdown_link_anchors`).
	 */
	reference: string;
	text: string;
	/** Where its source starts, a UTF-16 offset into the document. */
	start: number;
	/** Where its source ends (exclusive) — with `start`, how its rendered anchor is found. */
	end: number;
	target: MarkdownLinkTarget;
	/** For a path link checked against an index, how it stands; else `null`. */
	status: MarkdownLinkStatus | null;
	/** For a `skipped` link, the part of its path the file index skips; else `null`. */
	unindexed: FileIndexUnindexedPart | null;
}

export interface ToMarkdownLinksOptions {
	/** The absolute path of the document's file — without it, path links are `inert`. */
	file_path?: string | null | undefined;
	/** What the file index knows; without it, nothing gets a `status`. */
	index?: MarkdownLinkIndex | null | undefined;
}

/**
 * The document's links that render as `<a>` elements (mdz renders an unsafe
 * reference as plain text), in rendered order, each resolved against
 * `file_path` and checked against `index`. A root-relative link resolves
 * against the innermost of the index's roots holding the file, a top-level
 * root included.
 *
 * @param nodes - the document, parsed by `mdz_parse`
 * @param options - the document's file and the file index
 */
export const to_markdown_links = (
	nodes: ReadonlyArray<MdzNode>,
	options: ToMarkdownLinksOptions = {}
): Array<MarkdownLink> => {
	const { file_path, index } = options;
	// TODO root-relative links resolve against the innermost indexed tree — a registry project's
	// focused repo, a checkout's root — not the repository's root as such: a plain directory
	// opened inside a repository reads them from there
	const root_dir =
		file_path && index ? to_root_dir(file_path, [...index.roots, ...index.top_level_roots]) : null;
	const links: Array<MarkdownLink> = [];
	walk_rendered(nodes, (node) => {
		if (node.type !== 'Link' || !mdz_is_safe_reference(node.reference)) return;
		const target = resolve_markdown_link(node.reference, { file_path, root_dir });
		const checked = target.kind === 'path' && index ? check_markdown_link(target, index) : null;
		links.push({
			reference: node.reference,
			text: to_mdz_plain_text(node.children).trim(),
			start: node.start,
			end: node.end,
			target,
			status: checked?.status ?? null,
			unindexed: checked?.unindexed ?? null
		});
	});
	return links;
};

/**
 * The rendered `<a>` of each of `links` inside `container`, or `null` for a
 * link with none — the `i`th entry is the `i`th link's. An anchor is paired
 * by the source offsets mdz puts on it (`Mdz`'s `source_offsets`, which must
 * be on), matching the link node's `start` and `end` exactly, so an anchor
 * mdz didn't render for a link node — one an injected component renders,
 * which carries another node's offsets or none — pairs with nothing. Offsets,
 * not `href`, because the `href` isn't always the reference: mdz renders a
 * root-relative one through SvelteKit's `resolve`, collapsing its leading run
 * of `/` and `\` to one `/` (`//a/b.md` renders `/a/b.md`), so an anchor that
 * reads as a path can stand for a reference this module reads as
 * protocol-relative or backslashed, and inert.
 *
 * @param container - the element mdz rendered the document into, with `source_offsets` on
 * @param links - the document's links, from `to_markdown_links`
 */
export const query_markdown_link_anchors = (
	container: ParentNode,
	links: ReadonlyArray<MarkdownLink>
): Array<HTMLAnchorElement | null> => {
	const by_offsets: Map<string, HTMLAnchorElement> = new Map();
	for (const anchor of container.querySelectorAll('a[href][data-mdz-start][data-mdz-end]')) {
		if (!(anchor instanceof HTMLAnchorElement)) continue;
		const key = to_markdown_anchor_key(anchor);
		// the first wins - mdz renders one anchor per link node
		if (key !== null && !by_offsets.has(key)) by_offsets.set(key, anchor);
	}
	return links.map((link) => by_offsets.get(`${link.start}:${link.end}`) ?? null);
};

/**
 * The index in `links` of the link `anchor` was rendered for, by the source
 * offsets mdz put on it, or `-1` when it matches none (see
 * `query_markdown_link_anchors`).
 */
export const find_markdown_link_index = (
	anchor: Element,
	links: ReadonlyArray<MarkdownLink>
): number => {
	const key = to_markdown_anchor_key(anchor);
	if (key === null) return -1;
	return links.findIndex((link) => `${link.start}:${link.end}` === key);
};

const to_markdown_anchor_key = (anchor: Element): string | null => {
	const start = anchor.getAttribute('data-mdz-start');
	const end = anchor.getAttribute('data-mdz-end');
	return start === null || end === null ? null : `${start}:${end}`;
};

/** Why the file index skips a link's target, for its title. */
const to_unindexed_cause = (part: FileIndexUnindexedPart | null): string => {
	switch (part?.by) {
		case 'git':
			return 'ignored by git';
		case 'nested':
			return 'in a repo of its own';
		default:
			return 'skipped by name';
	}
};

/**
 * The title a link shows on hover to say how it stands, or `null` for a link
 * that needs none.
 *
 * @param link - a resolved link
 * @param readme_path - for a folder link, the README it opens, if any
 */
export const to_markdown_link_title = (
	link: MarkdownLink,
	readme_path: string | null = null
): string | null => {
	const { target, status } = link;
	if (target.kind !== 'path') return null;
	switch (status) {
		case 'broken':
			return `not found: ${target.path}`;
		case 'outside':
			return `outside the open projects: ${target.path}`;
		case 'unfocused':
			return `in a repo that isn't focused, which the file index doesn't cover: ${target.path}`;
		case 'skipped':
			return `not indexed, ${to_unindexed_cause(link.unindexed)}: ${target.path}`;
		case 'root_relative':
			return `not found from the project root: ${target.path}`;
		case 'directory':
			return readme_path === null
				? `a folder, which zzz has no view for: ${target.path}`
				: `opens the folder's readme: ${readme_path}`;
		default:
			return null;
	}
};
