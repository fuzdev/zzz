import { SvelteSet } from 'svelte/reactivity';

import type { Frontend } from './frontend.svelte.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import {
	FILE_INDEX_IGNORED_DIR_NAMES,
	FILE_INDEX_TEMP_FILE_PREFIX,
	to_file_directories
} from './diskfile_helpers.ts';

/**
 * The file tree as the explorer's tree mode shows it: the expanded folders,
 * the active row the keyboard moves, and the visible rows derived from them.
 * Lives on `DiskfilesEditor`, so the expanded set outlives a switch to the list
 * and back, and any remount of the tree.
 *
 * The rows come from `Diskfiles.tree_index`, kept in step as files come and go,
 * and only expanded folders are walked: deriving the rows costs what they show,
 * never the size of the index.
 *
 * @module
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares names the way a file explorer sorts them: case-insensitive and
 * numeric-aware (`file9` before `file10`), with a plain code-unit comparison
 * breaking ties so the order is total and stable.
 */
export const compare_natural = (a: string, b: string): number =>
	collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** A folder's children: folders (each with a trailing `/`), then files — each sorted by name. */
export interface DiskfileTreeChildren {
	readonly dirs: ReadonlyArray<string>;
	readonly files: ReadonlyArray<string>;
}

const EMPTY_CHILDREN: DiskfileTreeChildren = { dirs: [], files: [] };

/**
 * Sorts the children of folder `dir` by name with `compare_natural`.
 *
 * @param dir - the folder, with a trailing `/`
 * @param dirs - its child folders, each with a trailing `/`
 * @param files - its child files
 */
export const sort_diskfile_tree_children = (
	dir: string,
	dirs: Iterable<string>,
	files: Iterable<string>
): DiskfileTreeChildren => {
	const start = dir.length;
	return {
		dirs: Array.from(dirs).sort((a, b) => compare_natural(a.slice(start, -1), b.slice(start, -1))),
		files: Array.from(files).sort((a, b) => compare_natural(a.slice(start), b.slice(start)))
	};
};

interface DiskfileTreeIndexEntry {
	/** Child folders, each with how many of the files counted here pass through it. */
	readonly dirs: Map<string, number>;
	readonly files: Set<string>;
	/** Cleared by any change to `dirs` or `files`. */
	sorted: DiskfileTreeChildren | null;
}

/**
 * Each folder's direct children, kept in step one file at a time — a file
 * adds itself to its parent and links each folder to the next one up, the
 * way `to_file_directories` lists them, so an add or remove costs the file's
 * depth, never the size of the index. A folder is in it while some counted
 * file is under it. `Diskfiles` links every file up to `/`, not to its
 * `source_dir` (whichever root's filer reported it last), so a root nested in
 * another shows under it as a folder (unless it's inside an ignored folder —
 * see `to_diskfile_tree_rows`), and the outer root keeps its files after the
 * nested one closes. Links are counted, so a folder stays while any file
 * passes through it.
 *
 * Fed by `Diskfiles` with the files on disk. Its maps aren't reactive: every
 * change bumps `version`, which every read tracks, so a reader reruns once
 * per batch of changes — and only `add_file` and `remove_file` (a file
 * appearing or going), never a file's content changing.
 */
export class DiskfileTreeIndex {
	/** Bumped by every change. */
	version: number = $state.raw(0);

	readonly #entries: Map<string, DiskfileTreeIndexEntry> = new Map();

	/** Makes the calling reader depend on every change — the entries themselves aren't reactive. */
	#track(): number {
		return this.version;
	}

	/**
	 * Counts the file at `path` under its folders.
	 *
	 * @param dirs - its folders, innermost first, as `to_file_directories` gives them
	 */
	add_file(path: string, dirs: ReadonlyArray<string>): void {
		let child = path;
		for (let i = 0; i < dirs.length; i++) {
			const dir = dirs[i]!;
			let entry = this.#entries.get(dir);
			if (!entry) {
				entry = { dirs: new Map(), files: new Set(), sorted: null };
				this.#entries.set(dir, entry);
			}
			if (i === 0) {
				entry.files.add(child);
				entry.sorted = null;
			} else {
				const count = entry.dirs.get(child) ?? 0;
				entry.dirs.set(child, count + 1);
				if (count === 0) entry.sorted = null;
			}
			child = dir;
		}
		this.version++;
	}

	/**
	 * Uncounts the file at `path` — `dirs` must be what it was added with.
	 *
	 * @param dirs - its folders, innermost first, as `to_file_directories` gives them
	 */
	remove_file(path: string, dirs: ReadonlyArray<string>): void {
		let child = path;
		for (let i = 0; i < dirs.length; i++) {
			const dir = dirs[i]!;
			const entry = this.#entries.get(dir);
			if (entry) {
				if (i === 0) {
					entry.files.delete(child);
					entry.sorted = null;
				} else {
					const count = (entry.dirs.get(child) ?? 0) - 1;
					if (count > 0) {
						entry.dirs.set(child, count);
					} else {
						entry.dirs.delete(child);
						entry.sorted = null;
					}
				}
				if (entry.files.size === 0 && entry.dirs.size === 0) this.#entries.delete(dir);
			}
			child = dir;
		}
		this.version++;
	}

	/** The children of folder `dir`, sorted (and cached until it changes). Reruns a reader on any change. */
	get_children(dir: string): DiskfileTreeChildren {
		this.#track();
		const entry = this.#entries.get(dir);
		if (!entry) return EMPTY_CHILDREN;
		return (entry.sorted ??= sort_diskfile_tree_children(dir, entry.dirs.keys(), entry.files));
	}

	/**
	 * The one child of folder `dir` when it holds a single folder and no files —
	 * the chain compact folders collapse into one row — else `null`. Reruns a
	 * reader on any change.
	 */
	get_only_child_dir(dir: string): string | null {
		this.#track();
		const entry = this.#entries.get(dir);
		if (!entry || entry.files.size > 0 || entry.dirs.size !== 1) return null;
		return entry.dirs.keys().next().value!;
	}
}

interface DiskfileTreeRowBase {
	/**
	 * Unique among the rows: the root and the path, since overlapping roots
	 * can show one path under each (see `to_diskfile_tree_row_key`).
	 */
	readonly key: string;
	/** The root the row is shown under. */
	readonly root: string;
	/** The file's path, or the folder's with a trailing `/` — a compact row's innermost one. */
	readonly path: string;
	/** The name shown: relative to the parent row, `a/b/c` for compact folders, the path for a root. */
	readonly label: string;
	/** `0` for a root — `aria-level` is one more. */
	readonly depth: number;
	/** How many rows share the parent row, for `aria-setsize`. */
	readonly setsize: number;
	/** The row's 1-based position among them, for `aria-posinset`. */
	readonly posinset: number;
	/** The parent row's `key`, `null` for a root. */
	readonly parent_key: string | null;
}

export interface DiskfileTreeDirRow extends DiskfileTreeRowBase {
	readonly kind: 'root' | 'dir';
	/**
	 * The folders the row shows, outermost first: one for a root or a plain
	 * folder, the whole chain for a compact row (`path` is the last).
	 */
	readonly chain: ReadonlyArray<string>;
	/**
	 * Whether the row is expanded: a root unless collapsed, a folder row when
	 * its outermost folder (`chain[0]`) is — see `DiskfileTreeState.set_expanded`.
	 */
	readonly expanded: boolean;
}

export interface DiskfileTreeFileRow extends DiskfileTreeRowBase {
	readonly kind: 'file';
}

/** One visible row of the file tree. */
export type DiskfileTreeRow = DiskfileTreeDirRow | DiskfileTreeFileRow;

/** What `to_diskfile_tree_rows` reads the tree through. */
export interface DiskfileTreeSource {
	/** The children of folder `dir`, sorted. */
	get_children: (dir: string) => DiskfileTreeChildren;
	/** The one child folder of `dir` when it holds nothing else, else `null`. */
	get_only_child_dir: (dir: string) => string | null;
	/** Whether the root or folder at `path` shows its children. */
	is_expanded: (path: string, kind: 'root' | 'dir') => boolean;
	/**
	 * Whether `child`, a folder in `dir`, is one the file index never enters
	 * from the root around it — so its files can only come from a root nested
	 * inside it, which shows as its own root.
	 */
	is_ignored_dir: (child: string, dir: string) => boolean;
}

/** The `key` of the row for `path` under `root` — NUL can't appear in a path. */
export const to_diskfile_tree_row_key = (root: string, path: string): string => `${root}\0${path}`;

/**
 * Flattens the tree into its visible rows, in display order: each root (once,
 * however often `roots` lists it), then — while it's expanded — its folders
 * and files, depth first, folders before files. A chain of folders that each
 * hold only the next one shows as one row labeled `a/b/c`, whose path is the
 * innermost; it's expanded when its outermost folder is. Walks only expanded
 * folders.
 *
 * A folder the file index never enters from the root around it (the source's
 * `is_ignored_dir`) isn't shown under that root: its files can only come from
 * a root nested inside it — say the app directory inside a workspace — which
 * shows as its own root.
 *
 * @param roots - the indexed roots, each with a trailing `/`
 */
export const to_diskfile_tree_rows = (
	roots: ReadonlyArray<string>,
	source: DiskfileTreeSource
): Array<DiskfileTreeRow> => {
	const rows: Array<DiskfileTreeRow> = [];
	const unique_roots = Array.from(new Set(roots));
	for (let i = 0; i < unique_roots.length; i++) {
		const root = unique_roots[i]!;
		const key = to_diskfile_tree_row_key(root, root);
		const expanded = source.is_expanded(root, 'root');
		rows.push({
			kind: 'root',
			key,
			root,
			path: root,
			label: root,
			depth: 0,
			setsize: unique_roots.length,
			posinset: i + 1,
			parent_key: null,
			chain: [root],
			expanded
		});
		if (expanded) push_children(rows, source, root, root, key, 1);
	}
	return rows;
};

const push_children = (
	rows: Array<DiskfileTreeRow>,
	source: DiskfileTreeSource,
	root: string,
	dir: string,
	parent_key: string,
	depth: number
): void => {
	const children = source.get_children(dir);
	const dirs = children.dirs.filter((child) => !source.is_ignored_dir(child, dir));
	const { files } = children;
	const setsize = dirs.length + files.length;
	let posinset = 0;
	for (const child of dirs) {
		let path = child;
		let label = child.slice(dir.length, -1);
		const chain = [child];
		for (
			let only = source.get_only_child_dir(path);
			only && !source.is_ignored_dir(only, path);
			only = source.get_only_child_dir(path)
		) {
			label += '/' + only.slice(path.length, -1);
			path = only;
			chain.push(only);
		}
		const key = to_diskfile_tree_row_key(root, path);
		const expanded = source.is_expanded(child, 'dir');
		rows.push({
			kind: 'dir',
			key,
			root,
			path,
			label,
			depth,
			setsize,
			posinset: ++posinset,
			parent_key,
			chain,
			expanded
		});
		if (expanded) push_children(rows, source, root, path, key, depth + 1);
	}
	for (const path of files) {
		rows.push({
			kind: 'file',
			key: to_diskfile_tree_row_key(root, path),
			root,
			path,
			label: path.slice(dir.length),
			depth,
			setsize,
			posinset: ++posinset,
			parent_key
		});
	}
};

export interface DiskfileTreeStateOptions {
	app: Frontend;
}

/** What `DiskfileTreeState` adds to a folder's children in the index — see `#extra`. */
interface DiskfileTreeExtraEntry {
	readonly dirs: Set<string>;
	readonly files: Array<string>;
}

export class DiskfileTreeState {
	readonly app: Frontend;

	/**
	 * The expanded folders, by path with a trailing `/` — for a compact row
	 * opened as one, every folder in its chain (see `set_expanded`). Roots
	 * aren't in it; see `collapsed_roots`.
	 */
	readonly expanded: SvelteSet<string> = new SvelteSet();

	/** Roots start expanded; these are the ones collapsed. */
	readonly collapsed_roots: SvelteSet<string> = new SvelteSet();

	/** The `key` of the row the keyboard acts on — see `active_row`. */
	active_key: string | null = $state.raw(null);

	/**
	 * Bumped when the active row should scroll into view: by keyboard moves and
	 * `reveal`, not by clicks, so it never fights the user's own scrolling.
	 */
	scroll_request: number = $state.raw(0);

	/**
	 * What the tree shows that `Diskfiles.tree_index` lacks, merged into the
	 * children it lists: files deleted on disk but kept for their drafts
	 * (`Diskfiles.listed_deleted`), with their folders up to `/` like the
	 * index's — the index holds files on disk only. Rarely more than a few, so
	 * it's rebuilt whole.
	 */
	readonly #extra: Map<string, DiskfileTreeExtraEntry> = $derived.by(() => {
		const extra: Map<string, DiskfileTreeExtraEntry> = new Map();
		for (const diskfile of this.app.diskfiles.listed_deleted) {
			let child: string = diskfile.path;
			const dirs = to_file_directories(diskfile.path, '/');
			for (let i = 0; i < dirs.length; i++) {
				const dir = dirs[i]!;
				let entry = extra.get(dir);
				if (!entry) {
					entry = { dirs: new Set(), files: [] };
					extra.set(dir, entry);
				}
				if (i === 0) {
					entry.files.push(child);
				} else {
					entry.dirs.add(child);
				}
				child = dir;
			}
		}
		return extra;
	});

	readonly #source: DiskfileTreeSource = {
		get_children: (dir) => this.get_children(dir),
		get_only_child_dir: (dir) => {
			if (!this.#extra.has(dir)) return this.app.diskfiles.tree_index.get_only_child_dir(dir);
			const { dirs, files } = this.get_children(dir);
			return files.length === 0 && dirs.length === 1 ? dirs[0]! : null;
		},
		is_expanded: (path, kind) =>
			kind === 'root' ? !this.collapsed_roots.has(path) : this.expanded.has(path),
		// the filer's rules: ignored names and staging names anywhere, and the app
		// directory by its path — which only another root's walk can reach
		is_ignored_dir: (child, dir) => {
			const name = child.slice(dir.length, -1);
			return (
				FILE_INDEX_IGNORED_DIR_NAMES.has(name) ||
				name.startsWith(FILE_INDEX_TEMP_FILE_PREFIX) ||
				child === this.app.zzz_dir
			);
		}
	};

	/** The visible rows, in display order — see `to_diskfile_tree_rows`. */
	readonly rows: Array<DiskfileTreeRow> = $derived.by(() => {
		return to_diskfile_tree_rows(this.app.diskfiles.indexed_roots, this.#source);
	});

	/**
	 * The index of `active_row` in `rows`, `-1` when there's none. When the
	 * active row is hidden — its folder collapsed, or its file deleted — it's the
	 * deepest visible row that holds its path, as in VS Code, so the keyboard
	 * picks up there and not at the top.
	 */
	readonly active_index: number = $derived.by(() => {
		const { active_key, rows } = this;
		if (active_key === null) return -1;
		const index = rows.findIndex((row) => row.key === active_key);
		if (index !== -1) return index;
		const separator = active_key.indexOf('\0');
		const root = active_key.slice(0, separator);
		const path = active_key.slice(separator + 1);
		// the rows holding `path` are all its ancestors, in order, so the last is the deepest
		let found = -1;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			if (row.kind !== 'file' && row.root === root && path.startsWith(row.chain[0]!)) found = i;
		}
		return found;
	});

	/** The row the keyboard acts on, if any — see `active_index`. */
	readonly active_row: DiskfileTreeRow | undefined = $derived(
		this.active_index === -1 ? undefined : this.rows[this.active_index]
	);

	constructor(options: DiskfileTreeStateOptions) {
		this.app = options.app;
	}

	/** The children of folder `dir`, sorted, with what `#extra` adds. */
	get_children(dir: string): DiskfileTreeChildren {
		const children = this.app.diskfiles.tree_index.get_children(dir);
		const extra = this.#extra.get(dir);
		if (!extra) return children;
		return sort_diskfile_tree_children(dir, new Set([...children.dirs, ...extra.dirs]), [
			...children.files,
			...extra.files
		]);
	}

	/**
	 * Expands or collapses a root or folder row. A compact row expands or
	 * collapses every folder in its chain, and reads expanded by its outermost
	 * folder alone, so a compact row opened as one stays open when its chain
	 * splits (`a/b/c` becomes `a/b` over `c`, when `a/b` gains a file) or
	 * grows (`a` becomes `a/b`, when `b` becomes all `a` holds), and a deeper
	 * folder left expanded inside it — collapsing `a` keeps `b` expanded, as
	 * VS Code does — never reopens it. A row opened before it grew (`a`, now
	 * `a/b`) holds only `a` in the set, so a later split shows `b` collapsed.
	 */
	set_expanded(row: DiskfileTreeDirRow, expanded: boolean): void {
		if (row.kind === 'root') {
			if (expanded) {
				this.collapsed_roots.delete(row.path);
			} else {
				this.collapsed_roots.add(row.path);
			}
			return;
		}
		for (const folder of row.chain) {
			if (expanded) {
				this.expanded.add(folder);
			} else {
				this.expanded.delete(folder);
			}
		}
	}

	toggle(row: DiskfileTreeDirRow): void {
		this.set_expanded(row, !row.expanded);
	}

	/**
	 * Collapses every folder and root. A hidden active row then acts from its
	 * root (see `active_index`).
	 */
	collapse_all(): void {
		this.expanded.clear();
		for (const row of this.rows) {
			if (row.kind === 'root') this.collapsed_roots.add(row.path);
		}
	}

	/** Makes row `index` (clamped to the rows) active and asks for it to scroll into view. */
	move_to(index: number): void {
		const { rows } = this;
		if (!rows.length) return;
		this.active_key = rows[Math.max(0, Math.min(rows.length - 1, index))]!.key;
		this.scroll_request++;
	}

	/** Moves the active row by `delta` rows — from the first row when none is active. */
	move(delta: number): void {
		const index = this.active_index;
		this.move_to(index === -1 ? 0 : index + delta);
	}

	/**
	 * The active row, made `active_key` — so acting on the row a hidden one
	 * fell back to (see `active_index`) continues from it, not from the stale
	 * row below it once that shows again.
	 */
	#take_active_row(): DiskfileTreeRow | undefined {
		const row = this.active_row;
		if (row && row.key !== this.active_key) this.active_key = row.key;
		return row;
	}

	/** ArrowRight: expands a collapsed folder, or moves into an expanded one's first child. */
	expand_active(): void {
		const row = this.#take_active_row();
		if (!row) {
			this.move_to(0);
			return;
		}
		if (row.kind === 'file') return;
		if (!row.expanded) {
			this.set_expanded(row, true);
			return;
		}
		const next = this.rows[this.active_index + 1];
		if (next?.parent_key === row.key) this.move_to(this.active_index + 1);
	}

	/** ArrowLeft: collapses an expanded folder, or moves to the parent row. */
	collapse_active(): void {
		const row = this.#take_active_row();
		if (!row) {
			this.move_to(0);
			return;
		}
		if (row.kind !== 'file' && row.expanded) {
			this.set_expanded(row, false);
			return;
		}
		if (row.parent_key !== null) {
			this.active_key = row.parent_key;
			this.scroll_request++;
		}
	}

	/**
	 * Enter and Space: opens the active file — in a permanent tab if
	 * `open_not_preview`, else a preview (see `Diskfiles.select`) — or toggles
	 * the active folder.
	 */
	open_active(open_not_preview: boolean): void {
		const row = this.#take_active_row();
		if (!row) return;
		if (row.kind === 'file') {
			const diskfile = this.app.diskfiles.get_by_path(row.path as DiskfilePath);
			if (diskfile) this.app.diskfiles.select(diskfile.id, open_not_preview);
		} else {
			this.toggle(row);
		}
	}

	/**
	 * Shows the file or folder at `path`: expands its ancestors, makes its row
	 * active, and asks for it to scroll into view. A folder inside a compact
	 * row reveals that row, as it was — its own chain isn't expanded. It's
	 * shown under the innermost root holding it. A root's path reveals its
	 * row.
	 *
	 * @param path - a file's path, or a folder's with a trailing `/`
	 * @returns whether the path is in the tree
	 */
	reveal(path: string): boolean {
		const root_row = this.rows.find((row) => row.kind === 'root' && row.path === path);
		if (root_row) {
			this.active_key = root_row.key;
			this.scroll_request++;
			return true;
		}
		const root = this.#to_root(path);
		if (!root) return false;
		const dirs = to_file_directories(path.endsWith('/') ? path.slice(0, -1) : path, root);
		const parent = dirs[0];
		if (!parent) return false;
		// a folder the root's walk never enters hides everything below it, so check
		// each folder from `path` (if a folder) up to the root's child before changing anything
		const folders = path.endsWith('/') ? [path, ...dirs] : dirs;
		for (let i = 0; i + 1 < folders.length; i++) {
			if (this.#source.is_ignored_dir(folders[i]!, folders[i + 1]!)) return false;
		}
		const siblings = this.get_children(parent);
		if (!(path.endsWith('/') ? siblings.dirs : siblings.files).includes(path)) return false;
		// a folder's own compact row: the ancestors that hold only the next one down to it
		let own_row = 0;
		if (path.endsWith('/')) {
			let below = path;
			while (
				own_row < dirs.length &&
				dirs[own_row] !== root &&
				this.#source.get_only_child_dir(dirs[own_row]!) === below
			) {
				below = dirs[own_row++]!;
			}
		}
		this.collapsed_roots.delete(root);
		for (let i = own_row; i < dirs.length; i++) {
			if (dirs[i] !== root) this.expanded.add(dirs[i]!);
		}
		// the row showing `path`: its own, or the compact row a folder is part of —
		// the shortest folder row under the root whose path starts with it
		let found: DiskfileTreeRow | undefined;
		for (const row of this.rows) {
			if (row.root !== root || !row.path.startsWith(path)) continue;
			if (row.path === path) {
				found = row;
				break;
			}
			if (row.kind === 'dir' && (!found || row.path.length < found.path.length)) found = row;
		}
		if (!found) return false;
		this.active_key = found.key;
		this.scroll_request++;
		return true;
	}

	/** The root `path` shows under for `reveal`: the innermost holding it. */
	#to_root(path: string): string | null {
		let found: string | null = null;
		for (const root of this.app.diskfiles.indexed_roots) {
			if (path.length > root.length && path.startsWith(root)) {
				if (!found || root.length > found.length) found = root;
			}
		}
		return found;
	}
}
