import {Parts} from './parts.svelte.js';
import {TextPart, DiskfilePart} from './part.svelte.js';
import {Capabilities} from './capabilities.svelte.js';
import {Chat} from './chat.svelte.js';
import {Chats} from './chats.svelte.js';
import {Diskfile} from './diskfile.svelte.js';
import {DiskfileTab} from './diskfile_tab.svelte.js';
import {DiskfileTabs} from './diskfile_tabs.svelte.js';
import {DiskfileHistory} from './diskfile_history.svelte.js';
import {Diskfiles} from './diskfiles.svelte.js';
import {DiskfilesEditor} from './diskfiles_editor.svelte.js';
import {Model} from './model.svelte.js';
import {Models} from './models.svelte.js';
import {Action} from './action.svelte.js';
import {Actions} from './actions.svelte.js';
import {Prompt} from './prompt.svelte.js';
import {Prompts} from './prompts.svelte.js';
import {Provider} from './provider.svelte.js';
import {Providers} from './providers.svelte.js';
import {Socket} from './socket.svelte.js';
import {Turn} from './turn.svelte.js';
import {Thread} from './thread.svelte.js';
import {Threads} from './threads.svelte.js';
import {Time} from './time.svelte.js';
import {Space} from './space.svelte.js';
import {Spaces} from './spaces.svelte.js';
import {Ui} from './ui.svelte.js';
import type {Cell} from './cell.svelte.js';

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
	Socket,
	Turn,
	Thread,
	Threads,
	Time,
	TextPart,
	Ui,
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
	class_name: K,
): cell is CellRegistryMap[K] => cell?.constructor.name === class_name;

/**
 * Get a list of all registered cell class names.
 */
export const get_cell_class_names = (): Array<CellClassNames> =>
	Object.keys(cell_classes) as Array<CellClassNames>;
