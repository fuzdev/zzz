/**
 * The command palette's commands (`CommandPalette`): the intents a user can
 * run from it, each with its input bound from app state — the selected tab's
 * path, the explorer's mode — plus a few commands that aren't intents (the
 * tree's expand and collapse, view state the recent intents don't record).
 * An intent whose input the app state can't fill (open any file, move a
 * tab) has no command.
 *
 * @module
 */

import { all_intent_specs, type ViewName } from './action_specs.ts';
import type { LocalCallActionMethod } from './action_metatypes.ts';
import { to_diskfile_content_kind } from './diskfile_content_kind.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import type { Frontend } from './frontend.svelte.ts';
import type { FrontendIntentsApi } from './intent_spec.ts';
import {
	MARKDOWN_VIEW_MODES,
	MARKDOWN_VIEW_MODE_LABELS,
	to_default_markdown_view_mode
} from './markdown_view_mode.ts';
import type { RecentIntent } from './recent_intents.svelte.ts';
import { to_view_url } from './nav.ts';

/**
 * The pages the palette goes to (`view_show`), in its order — the dashboard's
 * main ones, not the experimental pages behind futuremode.
 */
export const PALETTE_VIEWS: ReadonlyArray<ViewName> = [
	'home',
	'chats',
	'prompts',
	'files',
	'projects',
	'terminals',
	'recordings',
	'jobs',
	'models',
	'providers',
	'capabilities',
	'actions',
	'settings',
	'docs',
	'about'
];

/** One entry in the command palette. */
export interface PaletteCommand {
	/** Unique among the commands listed together: the intent and its bound input, or the command's name. */
	readonly key: string;
	readonly label: string;
	/**
	 * The key a recent intent call matches it by (`to_palette_recent_key`),
	 * `null` for a command that isn't an intent, which the recent intents
	 * never record.
	 */
	readonly recent_key: string | null;
	/** Runs the command — call it from an event handler, never a `$derived`. */
	readonly run: () => void;
}

const intent_labels: ReadonlyMap<string, string> = new Map(
	all_intent_specs.map((spec) => [spec.method, spec.label])
);

/**
 * The key a call is recognized by when ranking recently used commands: the
 * method and its input without its `path` and its show / hide or pin
 * direction, so closing one file's tab counts as using "close the tab"
 * whatever the file, and a backtick's `sidebar_toggle` counts for the
 * palette's sidebar entry whichever way it goes.
 */
export const to_palette_recent_key = (method: string, input: unknown): string => {
	if (input === null || input === undefined) return method;
	if (typeof input !== 'object' || Array.isArray(input))
		return `${method} ${JSON.stringify(input)}`;
	const { path: _path, show: _show, pinned: _pinned, ...rest } = input as Record<string, unknown>;
	const keys = Object.keys(rest).sort();
	if (!keys.length) return method;
	return `${method} ${JSON.stringify(rest, keys)}`;
};

type IntentInput<TMethod extends LocalCallActionMethod> = Parameters<
	FrontendIntentsApi[TMethod]
>[0];

/**
 * Creates the commands the palette offers now, in roster order: tabs, the
 * explorer, the markdown view, the dashboard's panels, the other open
 * projects, and the pages but the one at `pathname`. A command that would
 * do nothing — no tab to close, nothing to go back to, the mode already
 * shown — is left out.
 *
 * Reads the app's state, so it re-runs inside a `$derived`; the commands'
 * `run`s call `app.intents` and must only run from an event handler.
 */
export const create_palette_commands = (
	app: Frontend,
	pathname: string | null = null
): Array<PaletteCommand> => {
	const commands: Array<PaletteCommand> = [];

	const add_intent = <TMethod extends LocalCallActionMethod>(
		method: TMethod,
		input: IntentInput<TMethod>,
		label: string = intent_labels.get(method) ?? method
	): void => {
		const recent_key = to_palette_recent_key(method, input);
		commands.push({
			key: recent_key,
			label,
			recent_key,
			run: () => {
				(app.intents[method] as (input: IntentInput<TMethod>) => unknown)(input);
			}
		});
	};

	const add_command = (key: string, label: string, run: () => void): void => {
		commands.push({ key, label, recent_key: null, run });
	};

	const { diskfiles, ui } = app;
	const { editor } = diskfiles;
	const { tabs, tree } = editor;
	const path: DiskfilePath | null = tabs.selected_path;

	// the selected tab
	if (path) {
		if (tabs.preview_tab?.path === path) add_intent('tab_pin', { path });
		add_intent('tab_close', { path });
	}
	if (tabs.recently_closed_tabs.length) add_intent('tab_reopen_closed', undefined);
	// a history entry that's the selected file again is skipped by the step, so it doesn't count
	if (tabs.back_paths.some((p) => p !== path)) add_intent('tab_back', undefined);
	if (tabs.forward_paths.some((p) => p !== path)) add_intent('tab_forward', undefined);

	// the explorer
	if (editor.explorer_mode === 'tree') {
		add_intent('explorer_mode_set', { mode: 'list' }, 'show the files as a list');
	} else {
		add_intent('explorer_mode_set', { mode: 'tree' }, 'show the files as a tree');
	}
	if (path) add_intent('file_reveal', { path });
	if (tree.expanded.size)
		add_command('tree_collapse_all', 'collapse all folders', () => tree.collapse_all());

	// the markdown view
	if (path && to_diskfile_content_kind(path) === 'markdown') {
		const current =
			diskfiles.markdown_view_modes.get(path) ??
			to_default_markdown_view_mode(diskfiles.peek(path)?.content_status !== 'unloadable');
		for (const mode of MARKDOWN_VIEW_MODES) {
			if (mode === current) continue;
			add_intent(
				'markdown_mode_set',
				{ path, mode },
				`show the markdown ${MARKDOWN_VIEW_MODE_LABELS[mode]}`
			);
		}
	}

	// the dashboard's panels
	add_intent(
		'sidebar_toggle',
		{ show: !ui.show_sidebar },
		ui.show_sidebar ? 'hide the sidebar' : 'show the sidebar'
	);
	add_intent(
		'desk_toggle',
		{ show: !ui.show_desk_menu },
		ui.show_desk_menu ? 'hide the desk menu' : 'show the desk menu'
	);
	add_intent(
		'desk_pin_toggle',
		{ pinned: !ui.desk_pinned },
		ui.desk_pinned ? 'unpin the desk menu' : 'pin the desk menu'
	);
	add_intent(
		'diskfile_details_toggle',
		{ show: !ui.show_diskfile_details },
		ui.show_diskfile_details ? 'hide the file details' : 'show the file details'
	);
	if (!ui.show_main_dialog) add_intent('main_menu_toggle', { show: true }, 'show the main menu');

	// the other open projects
	const names: Map<string, number> = new Map();
	for (const project of app.projects.items.values) {
		names.set(project.name, (names.get(project.name) ?? 0) + 1);
	}
	for (const project of app.projects.items.values) {
		if (project.id === app.projects.active_id) continue;
		// by root where two share a name
		const name = names.get(project.name)! > 1 ? project.root : project.name;
		add_intent('project_activate', { root: project.root }, `switch to the project ${name}`);
	}

	// the pages, but the one shown
	for (const view of PALETTE_VIEWS) {
		if (to_view_url(view) === pathname) continue;
		add_intent('view_show', { view }, view === 'home' ? 'go home' : `go to ${view}`);
	}

	return commands;
};

/**
 * When each recently used command last ran, by `recent_key`: the `seq` of
 * the newest applied call.
 */
export const to_palette_recency = (
	entries: ReadonlyArray<RecentIntent>
): ReadonlyMap<string, number> => {
	const recency: Map<string, number> = new Map();
	for (const entry of entries) {
		if (entry.outcome !== 'applied') continue;
		recency.set(to_palette_recent_key(entry.method, entry.input), entry.seq);
	}
	return recency;
};

/**
 * Where `query` falls in `label`: `0` at its start, `1` at a word's start,
 * `2` inside a word, `-1` nowhere. Ignores case.
 */
const to_match_rank = (label: string, query: string): number => {
	const lower = label.toLowerCase();
	let index = lower.indexOf(query);
	if (index === -1) return -1;
	if (index === 0) return 0;
	let rank = 2;
	while (index !== -1) {
		if (!/[a-z0-9]/.test(lower[index - 1]!)) {
			rank = 1;
			break;
		}
		index = lower.indexOf(query, index + 1);
	}
	return rank;
};

/**
 * The commands matching `query` — its text anywhere in the label, ignoring
 * case — best first: a match at the label's start, then at a word's start,
 * then inside a word; within each, the most recently used first, then roster
 * order. An empty query keeps every command, the recently used first.
 */
export const filter_palette_commands = (
	commands: ReadonlyArray<PaletteCommand>,
	query: string,
	recency: ReadonlyMap<string, number>
): Array<PaletteCommand> => {
	const q = query.trim().toLowerCase();
	const ranked: Array<{ command: PaletteCommand; rank: number; recent: number; index: number }> =
		[];
	for (let index = 0; index < commands.length; index++) {
		const command = commands[index]!;
		const rank = q ? to_match_rank(command.label, q) : 0;
		if (rank === -1) continue;
		const recent = command.recent_key === null ? 0 : (recency.get(command.recent_key) ?? 0);
		ranked.push({ command, rank, recent, index });
	}
	ranked.sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index);
	return ranked.map((r) => r.command);
};
