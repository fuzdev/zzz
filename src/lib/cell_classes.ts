import { Parts } from './parts.svelte.ts';
import { TextPart, DiskfilePart } from './part.svelte.ts';
import { Capabilities } from './capabilities.svelte.ts';
import { Chat } from './chat.svelte.ts';
import { Chats } from './chats.svelte.ts';
import { Diskfile } from './diskfile.svelte.ts';
import { DiskfileTab } from './diskfile_tab.svelte.ts';
import { DiskfileTabs } from './diskfile_tabs.svelte.ts';
import { DiskfileHistory } from './diskfile_history.svelte.ts';
import { Diskfiles } from './diskfiles.svelte.ts';
import { DiskfilesEditor } from './diskfiles_editor.svelte.ts';
import { Model } from './model.svelte.ts';
import { Models } from './models.svelte.ts';
import { Action } from './action.svelte.ts';
import { Actions } from './actions.svelte.ts';
import { Prompt } from './prompt.svelte.ts';
import { Prompts } from './prompts.svelte.ts';
import { Provider } from './provider.svelte.ts';
import { Providers } from './providers.svelte.ts';
import { Turn } from './turn.svelte.ts';
import { Thread } from './thread.svelte.ts';
import { Threads } from './threads.svelte.ts';
import { Time } from './time.svelte.ts';
import { Space } from './space.svelte.ts';
import { Spaces } from './spaces.svelte.ts';
import { Terminal } from './terminal.svelte.ts';
import { TerminalPreset } from './terminal_preset.svelte.ts';
import { Ui } from './ui.svelte.ts';
import { Workspace } from './workspace.svelte.ts';
import { Workspaces } from './workspaces.svelte.ts';
import type { Cell } from './cell.svelte.ts';

export const cell_classes = {
	Parts,
	Capabilities,
	Chat,
	Chats,
	Diskfile,
	DiskfileTab,
	DiskfileTabs,
	DiskfilePart,
	DiskfileHistory,
	Diskfiles,
	DiskfilesEditor,
	Model,
	Models,
	Action,
	Actions,
	Prompt,
	Prompts,
	Provider,
	Providers,
	Space,
	Spaces,
	Terminal,
	TerminalPreset,
	Turn,
	Thread,
	Threads,
	Time,
	TextPart,
	Ui,
	Workspace,
	Workspaces
} satisfies Record<string, typeof Cell<any>>;

export type CellClasses = typeof cell_classes;

export type CellClassNames = keyof CellClasses;

export type CellRegistryMap = {
	[K in CellClassNames]: InstanceType<CellClasses[K]>;
};

/**
 * Type guard to check if a cell is an instance of a specific cell class.
 */
export const is_cell_type = <K extends CellClassNames>(
	cell: Cell<any> | null | undefined,
	class_name: K
): cell is CellRegistryMap[K] => cell?.constructor.name === class_name;

/**
 * Get a list of all registered cell class names.
 */
export const get_cell_class_names = (): Array<CellClassNames> =>
	Object.keys(cell_classes) as Array<CellClassNames>;
