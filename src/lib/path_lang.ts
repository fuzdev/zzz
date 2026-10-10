/**
 * Which syntax a file is written in, from its path — for highlighting source
 * with fuz_code. Like `diskfile_content_kind.ts`, it reads the extension
 * alone, since the file index says nothing about a file's type.
 *
 * @module
 */

/**
 * The extension of the file at `path`, lowercased and without the dot: the
 * text after the last `.` of its last segment, `null` when that segment has
 * no `.`. A dotfile's name is its extension (`.bashrc` → `bashrc`), and a
 * trailing dot gives `''`.
 *
 * @param path - the file's path or name
 */
export const to_path_extension = (path: string): string | null => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot === -1 ? null : name.slice(dot + 1).toLowerCase();
};

/**
 * File extensions (lowercase, without the dot) and the fuz_code language each
 * is highlighted as — a primary id registered on fuz_code's
 * `syntax_styler_global`. JavaScript is highlighted by the TypeScript lexer
 * (it registers `js` as an alias); JSX and TSX are left out, since that lexer
 * doesn't read their markup.
 */
export const LANG_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
	['ts', 'ts'],
	['mts', 'ts'],
	['cts', 'ts'],
	['js', 'ts'],
	['mjs', 'ts'],
	['cjs', 'ts'],
	['svelte', 'svelte'],
	['css', 'css'],
	['json', 'json'],
	['md', 'md'],
	['markdown', 'md'],
	['html', 'markup'],
	['htm', 'markup'],
	['svg', 'markup'],
	['xml', 'xml'],
	['sh', 'sh'],
	['bash', 'sh'],
	['rs', 'rust']
]);

/**
 * The fuz_code language to highlight the file at `path` as, by its extension
 * (case-insensitive), or `null` when there's none — which disables
 * highlighting.
 *
 * @param path - the file's path or name
 */
export const lang_for_path = (path: string): string | null => {
	const extension = to_path_extension(path);
	return extension === null ? null : (LANG_BY_EXTENSION.get(extension) ?? null);
};
