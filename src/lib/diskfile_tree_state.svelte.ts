import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type { Frontend } from './frontend.svelte.ts';
import { DiskfilePath, type DiskfileDirectoryPath } from './diskfile_types.ts';
import {
	normalize_path,
	parse_new_diskfile_name,
	to_file_directories,
	to_innermost_root,
	to_relative_path,
	to_unindexed_reason
} from './diskfile_helpers.ts';

/**
 * The file tree as the explorer's tree mode shows it: the expanded folders,
 * the active row the keyboard moves, the inline create in progress, and the
 * visible rows derived from them. Lives on `DiskfilesEditor`, so the expanded
 * set outlives a switch to the list and back, and any remount of the tree.
 *
 * The rows come from `DiskfileIndex.tree_index`, kept in step as files come and go,
 * and only expanded folders are walked: deriving the rows costs what they show,
 * never the size of the index.
 *
 * @module
 */

/**
 * How many files below a folder make "expand all below" ask first. Expanding
 * shows every file below, and every file change under an expanded folder
 * rederives all the visible rows, so a burst of changes there — a build's
 * output — pays for the whole subtree each time. A judgment, not a
 * measurement: a couple thousand rows is past what a person scrolls through,
 * and a rederive of that many stays small beside the explorer's other
 * per-change passes.
 */
export const EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT = 2000;

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
	 * How many files are below folder `dir`, at any depth — read off the
	 * counted links, so it costs `dir`'s children, not its subtree. Includes a
	 * nested root's files inside a folder the rows never show, so "expand all
	 * below" can ask when it needn't. Reruns a reader on any change.
	 */
	count_files_below(dir: string): number {
		this.#track();
		const entry = this.#entries.get(dir);
		if (!entry) return 0;
		let count = entry.files.size;
		for (const n of entry.dirs.values()) count += n;
		return count;
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
	 * every folder in its chain is — see `DiskfileTreeState.set_expanded`.
	 */
	readonly expanded: boolean;
}

export interface DiskfileTreeFileRow extends DiskfileTreeRowBase {
	readonly kind: 'file';
}

/**
 * A repo of a registry project that isn't focused, so the index holds none
 * of its files: a lazy folder row, shown from the project's entries, whose
 * expanding focuses it (`DiskfileTreeState.focus_repo`) — it then shows as a
 * folder row. `path` is the repo's dir.
 */
export interface DiskfileTreeUnfocusedRow extends DiskfileTreeRowBase {
	readonly kind: 'unfocused';
	/** The registry project's root. */
	readonly project_root: string;
}

/**
 * The inline input naming a new file or folder (`DiskfileTreeState.creating`),
 * shown as the first child of the folder it creates in. Not a file-system
 * row: its `label` is empty, its `path` is the folder's, and it isn't counted
 * among its siblings (`setsize` and `posinset` are `0`, not rendered).
 */
export interface DiskfileTreeCreateRow extends DiskfileTreeRowBase {
	readonly kind: 'create';
	readonly parent_key: string;
	readonly create_kind: DiskfileCreateKind;
}

/** One visible row of the file tree. */
export type DiskfileTreeRow =
	DiskfileTreeDirRow | DiskfileTreeFileRow | DiskfileTreeUnfocusedRow | DiskfileTreeCreateRow;

/** A folder that's a repo of an open registry project — see `DiskfileTreeSource.get_repo`. */
export interface DiskfileTreeRepo {
	/** The registry project's root. */
	readonly project_root: string;
	/** Whether the project focuses it, so the index holds its files. */
	readonly focused: boolean;
}

/** What an inline create makes. */
export type DiskfileCreateKind = 'file' | 'folder';

/**
 * An inline create in progress: where, what, and the name being typed. The
 * name lives here, not in the input, so it survives the input's row scrolling
 * out of the tree's window and back.
 */
export class DiskfileTreeCreate {
	readonly root: string;
	/** The folder it creates in, with a trailing `/`. */
	readonly dir: string;
	readonly kind: DiskfileCreateKind;
	name: string = $state.raw('');
	/** Why the last attempt was refused, by the name's parse or the backend. */
	error: string | null = $state.raw(null);
	/** Whether a create is in flight. */
	pending: boolean = $state.raw(false);
	/**
	 * Whether the input should take focus when it mounts — at the start, not
	 * when it remounts after scrolling. Not reactive.
	 */
	focus_pending: boolean = true;

	constructor(root: string, dir: string, kind: DiskfileCreateKind) {
		this.root = root;
		this.dir = dir;
		this.kind = kind;
	}
}

/** What `to_diskfile_tree_rows` reads the tree through. */
export interface DiskfileTreeSource {
	/** The children of folder `dir`, sorted. */
	get_children: (dir: string) => DiskfileTreeChildren;
	/** The one child folder of `dir` when it holds nothing else, else `null`. */
	get_only_child_dir: (dir: string) => string | null;
	/**
	 * Whether the root or folder at `path` is expanded — a compact row shows
	 * its children only when every folder in its chain is.
	 */
	is_expanded: (path: string, kind: 'root' | 'dir') => boolean;
	/**
	 * Whether the folder `child` is one the file index never enters from the
	 * root around it — so its files can only come from a root nested inside
	 * it, which shows as its own root.
	 */
	is_ignored_dir: (child: string) => boolean;
	/**
	 * The registry repo whose checkout `dir` is, if any. A repo's folder never
	 * joins a compact row, so its row is always its own, and an unfocused one
	 * shows as a lazy row with no children.
	 */
	get_repo: (dir: string) => DiskfileTreeRepo | null;
}

/** The `key` of the row for `path` under `root` — NUL can't appear in a path. */
export const to_diskfile_tree_row_key = (root: string, path: string): string => `${root}\0${path}`;

/**
 * The `key` of the inline create row in folder `dir` under `root`: the
 * folder row's key and a suffix no path holds. Made active, a missing one
 * falls back to its folder (see `DiskfileTreeState.active_index`).
 */
export const to_diskfile_tree_create_key = (root: string, dir: string): string =>
	`${to_diskfile_tree_row_key(root, dir)}\0create`;

/**
 * Flattens the tree into its visible rows, in display order: each root (once,
 * however often `roots` lists it), then — while it's expanded — its folders
 * and files, depth first, folders before files. A chain of folders that each
 * hold only the next one shows as one row labeled `a/b/c`, whose path is the
 * innermost; it's expanded when every folder in its chain is. Walks only
 * expanded folders.
 *
 * A folder the file index never enters from the root around it (the source's
 * `is_ignored_dir`) isn't shown under that root: its files can only come from
 * a root nested inside it — say the app directory inside a project — which
 * shows as its own root. A registry's repo (the source's `get_repo`) is
 * always a row of its own, never part of a compact one, and an unfocused one
 * is a lazy row with nothing under it.
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
	const dirs = children.dirs.filter((child) => !source.is_ignored_dir(child));
	const { files } = children;
	const setsize = dirs.length + files.length;
	let posinset = 0;
	for (const child of dirs) {
		let path = child;
		let label = child.slice(dir.length, -1);
		const repo = source.get_repo(child);
		if (repo && !repo.focused) {
			rows.push({
				kind: 'unfocused',
				key: to_diskfile_tree_row_key(root, child),
				root,
				path: child,
				label,
				depth,
				setsize,
				posinset: ++posinset,
				parent_key,
				project_root: repo.project_root
			});
			continue;
		}
		const chain = [child];
		for (
			let only = repo ? null : source.get_only_child_dir(path);
			only && !source.is_ignored_dir(only) && !source.get_repo(only);
			only = source.get_only_child_dir(path)
		) {
			label += '/' + only.slice(path.length, -1);
			path = only;
			chain.push(only);
		}
		const key = to_diskfile_tree_row_key(root, path);
		const expanded = chain.every((folder) => source.is_expanded(folder, 'dir'));
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
	 * The folders created here this page load (`commit_create`), each with a
	 * trailing `/`. The index lists files only, so an empty folder exists for
	 * the tree only through this; it lasts until a reload, and a folder later
	 * deleted by another program stays until then too.
	 */
	readonly created_dirs: SvelteSet<string> = new SvelteSet();

	/** The inline create in progress, if any — see `start_create`. */
	creating: DiskfileTreeCreate | null = $state.raw(null);

	/**
	 * A note on the last inline create, when what it made won't show — the
	 * file index skips it (`Diskfiles.to_unindexed`) — or on a repo focus or
	 * unfocus that failed (`focus_repo`, `unfocus_repo`). Cleared by the next
	 * create, focus, or unfocus, and by the tree on the next key or the note's
	 * dismiss button.
	 */
	notice: string | null = $state.raw(null);

	/**
	 * What the tree shows that `DiskfileIndex.tree_index` lacks, merged into the
	 * children it lists: files deleted on disk or out of the index but kept for
	 * a draft or a tab (`Diskfiles.listed_unindexed`), the folders in `created_dirs`, and the
	 * open registries' repos (`Projects.repos` — an unfocused one has no
	 * files, a focused one may have none yet), with their folders up to `/`
	 * like the index's — the index holds files on disk only. A few, or a
	 * registry's entries, so it's rebuilt whole.
	 */
	readonly #extra: Map<string, DiskfileTreeExtraEntry> = $derived.by(() => {
		const extra: Map<string, DiskfileTreeExtraEntry> = new Map();
		const link = (path: string, is_dir: boolean): void => {
			let child = path;
			const dirs = to_file_directories(is_dir ? path.slice(0, -1) : path, '/');
			for (let i = 0; i < dirs.length; i++) {
				const dir = dirs[i]!;
				let entry = extra.get(dir);
				if (!entry) {
					entry = { dirs: new Set(), files: [] };
					extra.set(dir, entry);
				}
				if (i === 0 && !is_dir) {
					entry.files.push(child);
				} else {
					entry.dirs.add(child);
				}
				child = dir;
			}
		};
		for (const diskfile of this.app.diskfiles.listed_unindexed) link(diskfile.path, false);
		for (const dir of this.created_dirs) link(dir, true);
		for (const dir of this.app.projects.repos.keys()) link(dir, true);
		return extra;
	});

	readonly #source: DiskfileTreeSource = {
		get_children: (dir) => this.get_children(dir),
		get_only_child_dir: (dir) => {
			if (!this.#extra.has(dir)) return this.app.diskfiles.index.tree_index.get_only_child_dir(dir);
			const { dirs, files } = this.get_children(dir);
			return files.length === 0 && dirs.length === 1 ? dirs[0]! : null;
		},
		is_expanded: (path, kind) =>
			kind === 'root' ? !this.collapsed_roots.has(path) : this.expanded.has(path),
		// the innermost root's rule — git's answer for a focused git root, else fixed
		// names — and the app directory by its path, which only another root's walk can reach
		is_ignored_dir: (child) =>
			child === this.app.zzz_dir || this.app.diskfiles.to_unindexed(child) !== null,
		get_repo: (dir) => {
			const project = this.app.projects.repos.get(dir);
			return project
				? {
						project_root: project.root,
						focused: project.focused.includes(dir as DiskfileDirectoryPath)
					}
				: null;
		}
	};

	/**
	 * The visible rows, in display order — see `to_diskfile_tree_rows` — with
	 * `creating`'s input as the first child of its folder while that's shown
	 * and expanded.
	 */
	readonly rows: Array<DiskfileTreeRow> = $derived.by(() => {
		const rows = to_diskfile_tree_rows(this.app.diskfiles.indexed_roots, this.#source);
		const { creating } = this;
		if (creating) {
			const parent_key = to_diskfile_tree_row_key(creating.root, creating.dir);
			const index = rows.findIndex((row) => row.key === parent_key);
			const parent = rows[index];
			if (parent && (parent.kind === 'root' || parent.kind === 'dir') && parent.expanded) {
				rows.splice(index + 1, 0, {
					kind: 'create',
					key: to_diskfile_tree_create_key(creating.root, creating.dir),
					root: creating.root,
					path: creating.dir,
					label: '',
					depth: parent.depth + 1,
					setsize: 0,
					posinset: 0,
					parent_key,
					create_kind: creating.kind
				});
			}
		}
		return rows;
	});

	/** The index of `creating`'s input row in `rows`, `-1` when none shows. */
	readonly create_index: number = $derived(
		this.creating ? this.rows.findIndex((row) => row.kind === 'create') : -1
	);

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
			if (
				(row.kind === 'root' || row.kind === 'dir') &&
				row.root === root &&
				path.startsWith(row.chain[0]!)
			) {
				found = i;
			}
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
		const children = this.app.diskfiles.index.tree_index.get_children(dir);
		const extra = this.#extra.get(dir);
		if (!extra) return children;
		return sort_diskfile_tree_children(dir, new Set([...children.dirs, ...extra.dirs]), [
			...children.files,
			...extra.files
		]);
	}

	/**
	 * Expands or collapses a root or folder row. A compact row expands or
	 * collapses every folder in its chain, and reads expanded only when every
	 * one is in `expanded`, so a row shows open only what the user opened:
	 * one opened as one stays open when its chain splits (`a/b/c` becomes
	 * `a/b` over `c`, when `a/b` gains a file); one that grows a folder never
	 * opened (`x` becomes `x/a/b`, when `a/b` becomes all `x` holds) shows
	 * collapsed; and a deeper folder left expanded when an outer one was
	 * collapsed — collapsing `a` keeps `b` expanded, as VS Code does — never
	 * reopens the row they merge into.
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

	/** How many files are below the folder at `path` — see `DiskfileTreeIndex.count_files_below`. */
	count_files_below(path: string): number {
		return this.app.diskfiles.index.tree_index.count_files_below(path);
	}

	/**
	 * Expands `row` and every folder below it, except the folders the rows
	 * never show (the source's `is_ignored_dir`) and unfocused repos, which
	 * it doesn't focus. Walks every folder below it,
	 * and the rows then list every file below it: on a large root that's the
	 * whole subtree, which windowing keeps cheap to render but not to derive.
	 */
	expand_all_below(row: DiskfileTreeDirRow): void {
		this.set_expanded(row, true);
		const stack = [row.path];
		while (stack.length) {
			const dir = stack.pop()!;
			for (const child of this.get_children(dir).dirs) {
				if (this.#source.is_ignored_dir(child)) continue;
				// an unfocused repo's row has nothing to expand, and expanding one focuses it
				if (this.#source.get_repo(child)?.focused === false) continue;
				this.expanded.add(child);
				stack.push(child);
			}
		}
	}

	/**
	 * Collapses `row` and every folder below it, so expanding it again shows
	 * one level. Expansion is by path, so a nested root's own row shows the
	 * folders below it collapsed too.
	 */
	collapse_below(row: DiskfileTreeDirRow): void {
		this.set_expanded(row, false);
		const top = row.chain[0]!;
		for (const folder of Array.from(this.expanded)) {
			if (folder.startsWith(top)) this.expanded.delete(folder);
		}
	}

	/**
	 * Starts naming a new file or folder inline, inside root or folder `row`
	 * (a compact row's innermost folder): expands it and shows the input as its
	 * first child, made active so the tree scrolls to it. Replaces any create
	 * in progress.
	 */
	start_create(row: DiskfileTreeDirRow, kind: DiskfileCreateKind): void {
		this.notice = null;
		this.set_expanded(row, true);
		this.creating = new DiskfileTreeCreate(row.root, row.path, kind);
		this.active_key = to_diskfile_tree_create_key(row.root, row.path);
		this.scroll_request++;
	}

	/** Ends the create in progress, the active row going back to its folder. */
	cancel_create(): void {
		const { creating } = this;
		if (!creating) return;
		this.creating = null;
		if (this.active_key === to_diskfile_tree_create_key(creating.root, creating.dir)) {
			this.active_key = to_diskfile_tree_row_key(creating.root, creating.dir);
		}
	}

	/**
	 * Creates what `creating` names inside its folder, then ends it. The name is
	 * parsed by `parse_new_diskfile_name`, so `a/b.ts` creates the folders on
	 * the way. A new file is selected in a permanent tab and revealed
	 * (`Diskfiles.create_file_at`); a new folder joins `created_dirs` — it's
	 * empty, so the index won't list it — and is revealed and expanded. An
	 * empty name ends it creating nothing; a refused name or a failed create
	 * keeps it open with `error` set. What the file index skips can't show, so
	 * `notice` says why. A create started while this one was in flight keeps
	 * the tree at its input: nothing is revealed.
	 *
	 * @returns whether something was created
	 */
	async commit_create(): Promise<boolean> {
		const { creating } = this;
		if (!creating || creating.pending) return false;
		if (!creating.name) {
			this.cancel_create();
			return false;
		}
		const parsed = parse_new_diskfile_name(creating.name, creating.kind);
		if (!parsed.ok) {
			creating.error = parsed.message;
			return false;
		}
		// `dir` has a trailing slash, and the parsed name has no leading one
		const path = parse_or_throw(DiskfilePath, creating.dir + parsed.value);
		const { diskfiles } = this.app;
		creating.error = null;
		creating.pending = true;
		try {
			if (creating.kind === 'file') {
				await diskfiles.create_file_at(path);
			} else {
				await diskfiles.create_directory_at(path);
			}
		} catch (error) {
			creating.error = to_error_message(error);
			return false;
		} finally {
			creating.pending = false;
		}
		// a create started meanwhile keeps the tree at its input
		const replaced = this.creating !== null && this.creating !== creating;
		if (this.creating === creating) this.cancel_create();
		const created = normalize_path(path);
		const root = to_innermost_root(created, this.app.diskfiles.indexed_roots);
		if (creating.kind === 'folder') {
			const dir = created + '/';
			this.created_dirs.add(dir);
			if (!replaced && this.reveal(dir)) {
				const row = this.active_row;
				if (row?.kind === 'dir' && row.path === dir) this.set_expanded(row, true);
			}
		}
		const skipped =
			root && diskfiles.to_unindexed(creating.kind === 'folder' ? created + '/' : created);
		if (skipped && !replaced) {
			this.notice = `created ${to_relative_path(created, root)}, which the tree doesn’t show: ${to_unindexed_reason(skipped, root)}`;
		}
		return true;
	}

	/**
	 * Makes row `index` (clamped to the rows) active and asks for it to scroll
	 * into view. The keyboard passes over `creating`'s input row, which it
	 * can't act on — to the next row in `direction`, else the one before — so
	 * focus never moves into the input without the user choosing it.
	 *
	 * @param direction - which way to pass over the input row
	 */
	move_to(index: number, direction: 1 | -1 = 1): void {
		const { rows } = this;
		if (!rows.length) return;
		let i = Math.max(0, Math.min(rows.length - 1, index));
		if (rows[i]!.kind === 'create') {
			const past = i + direction;
			i = past >= 0 && past < rows.length ? past : i - direction;
		}
		const row = rows[i];
		if (!row || row.kind === 'create') return;
		this.active_key = row.key;
		this.scroll_request++;
	}

	/** Moves the active row by `delta` rows — from the first row when none is active. */
	move(delta: number): void {
		const index = this.active_index;
		this.move_to(index === -1 ? 0 : index + delta, delta < 0 ? -1 : 1);
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

	/**
	 * ArrowRight: expands a collapsed folder, or moves into an expanded one's
	 * first child; focuses an unfocused repo (`focus_repo`).
	 */
	expand_active(): void {
		const row = this.#take_active_row();
		if (!row) {
			this.move_to(0);
			return;
		}
		if (row.kind === 'unfocused') {
			void this.focus_repo(row);
			return;
		}
		if (row.kind === 'file' || row.kind === 'create') return;
		if (!row.expanded) {
			this.set_expanded(row, true);
			return;
		}
		// into its first child past `creating`'s input row — none, when the input is all it holds
		let next = this.active_index + 1;
		if (this.rows[next]?.kind === 'create') next++;
		if (this.rows[next]?.parent_key === row.key) this.move_to(next);
	}

	/** ArrowLeft: collapses an expanded folder, or moves to the parent row. */
	collapse_active(): void {
		const row = this.#take_active_row();
		if (!row) {
			this.move_to(0);
			return;
		}
		if ((row.kind === 'root' || row.kind === 'dir') && row.expanded) {
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
	 * `open_not_preview`, else a preview (see `Diskfiles.select`) — toggles
	 * the active folder, or focuses the active unfocused repo. Does nothing on
	 * `creating`'s input row.
	 */
	open_active(open_not_preview: boolean): void {
		const row = this.#take_active_row();
		if (!row || row.kind === 'create') return;
		if (row.kind === 'unfocused') {
			void this.focus_repo(row);
		} else if (row.kind === 'file') {
			const path = row.path as DiskfilePath;
			// a file row is a file on disk, or one kept for a draft or a tab
			if (untrack(() => this.app.diskfiles.has_path(path))) {
				this.app.diskfiles.select(path, open_not_preview);
			}
		} else {
			this.toggle(row);
		}
	}

	/**
	 * Focuses the unfocused repo `row` shows (`Projects.focus_repo`), so its
	 * files are indexed, and shows them: the row turns into its folder's row,
	 * expanded, kept in view. A focus already in flight is left to land; a
	 * failure collapses it again and says why in `notice`.
	 *
	 * @returns whether it was focused
	 */
	async focus_repo(row: DiskfileTreeUnfocusedRow): Promise<boolean> {
		const { projects } = this.app;
		const dir = row.path as DiskfileDirectoryPath;
		if (projects.pending_repos.has(dir)) return false;
		this.notice = null;
		// expanded before it's a folder row, so it shows open as soon as it is
		this.expanded.add(dir);
		const result = await projects.focus_repo(row.project_root as DiskfileDirectoryPath, dir);
		if (!result.ok) {
			this.expanded.delete(dir);
			this.notice = `couldn’t focus ${row.label}: ${result.error.message}`;
			return false;
		}
		if (this.active_key === row.key) this.scroll_request++;
		return true;
	}

	/**
	 * Unfocuses the focused repo `row` shows (`Projects.unfocus_repo`): its
	 * files leave the tree, and the row turns into a lazy one. A failure says
	 * why in `notice`.
	 *
	 * @returns whether it was unfocused
	 */
	async unfocus_repo(row: DiskfileTreeDirRow): Promise<boolean> {
		const { projects } = this.app;
		const dir = row.path as DiskfileDirectoryPath;
		const project = projects.repos.get(dir);
		if (!project || projects.pending_repos.has(dir)) return false;
		this.notice = null;
		const result = await projects.unfocus_repo(project.root, dir);
		if (!result.ok) {
			this.notice = `couldn’t unfocus ${row.label}: ${result.error.message}`;
			return false;
		}
		return true;
	}

	/**
	 * Reveals a file this client just created (`Diskfiles.create_file_at`) —
	 * unless an inline create other than one in flight is open, which keeps the
	 * tree at its input.
	 *
	 * @returns whether it was revealed
	 */
	reveal_created(path: string): boolean {
		const { creating } = this;
		if (creating && !creating.pending) return false;
		return this.reveal(path);
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
		const root = to_innermost_root(path, this.app.diskfiles.indexed_roots);
		if (!root) return false;
		const dirs = to_file_directories(path.endsWith('/') ? path.slice(0, -1) : path, root);
		const parent = dirs[0];
		if (!parent) return false;
		// a folder the root's walk never enters hides everything below it, so check
		// each folder from `path` (if a folder) up to the root's child before changing anything
		const folders = path.endsWith('/') ? [path, ...dirs] : dirs;
		for (let i = 0; i + 1 < folders.length; i++) {
			if (this.#source.is_ignored_dir(folders[i]!)) return false;
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
				// a repo's folder is never part of a compact row, from either side
				!this.#source.get_repo(below) &&
				!this.#source.get_repo(dirs[own_row]!) &&
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
			if (row.kind === 'create' || row.root !== root || !row.path.startsWith(path)) continue;
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
}
