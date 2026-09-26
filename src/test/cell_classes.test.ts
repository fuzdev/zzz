// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { cell_classes, is_cell_type, type CellClassNames } from '$lib/cell_classes.ts';
import type { Cell } from '$lib/cell.svelte.ts';
import { Chat } from '$lib/chat.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import { providers_default } from '$lib/config_defaults.ts';

/** The least JSON each registered class accepts — its fields without defaults. */
const MINIMAL_JSON: Partial<Record<CellClassNames, object>> = {
	Action: { method: 'ping' },
	Diskfile: { path: '/w/a.txt', source_dir: '/w/' },
	DiskfileHistory: { path: '/w/a.txt' },
	DiskfileTab: { diskfile_id: create_uuid() },
	Model: { name: 'model', provider_name: 'claude' },
	Provider: providers_default[0],
	Turn: { role: 'user' },
	Workspace: { path: '/w/' }
};

let app: Frontend;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	app = new Frontend();
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

describe('registered cell classes', () => {
	for (const class_name of Object.keys(cell_classes) as Array<CellClassNames>) {
		test(`${class_name} is registered under its schema's name and initializes`, () => {
			const cell: Cell<any> = app.cell_registry.instantiate(
				class_name,
				MINIMAL_JSON[class_name] as any
			);
			assert.instanceOf(cell, cell_classes[class_name] as new (...args: Array<any>) => Cell<any>);
			assert.strictEqual(cell.schema.meta()?.cell_class_name, class_name);
			// `init()` ran: the schema applied and the cell registered itself
			assert.ok(cell.id);
			assert.ok(cell.created);
			assert.strictEqual(app.cell_registry.all.get(cell.id), cell);
		});
	}

	test('the app-level Capabilities cell is initialized', () => {
		const { capabilities } = app;
		assert.ok(capabilities.id);
		assert.strictEqual(app.cell_registry.all.get(capabilities.id), capabilities as Cell<any>);
		assert.deepEqual(Object.keys(capabilities.json).sort(), ['created', 'id', 'updated']);
	});
});

describe('registry names survive minification', () => {
	/** A subclass whose `name` is mangled, like a minified build's. */
	const mangle = <T extends abstract new (...args: Array<any>) => any>(
		base: T,
		name: string
	): T => {
		const mangled = class extends (base as any) {};
		Object.defineProperty(mangled, 'name', { value: name });
		return mangled as unknown as T;
	};

	test('instantiating and type checks use the registered name, not `constructor.name`', () => {
		const MangledChat = mangle(Chat, 'a');
		const MangledThread = mangle(Thread, 'b');
		app.dispose();
		app = new Frontend({
			cell_classes: { ...cell_classes, Chat: MangledChat, Thread: MangledThread }
		});

		const chat = app.cell_registry.instantiate('Chat');
		assert.instanceOf(chat, MangledChat);
		assert.strictEqual(chat.constructor.name, 'a');
		assert.ok(is_cell_type(chat, 'Chat'));
		assert.ok(!is_cell_type(chat, 'Thread'));
		assert.deepEqual(
			app.cell_registry.class_names.filter((name) => name === 'Chat' || name === 'a'),
			['Chat']
		);
	});

	test('decoding a cell-typed schema field instantiates the class its meta names', () => {
		const MangledChat = mangle(Chat, 'a');
		app.dispose();
		app = new Frontend({ cell_classes: { ...cell_classes, Chat: MangledChat } });

		// `ChatsJson.items` is `z.array(ChatJson)`, whose meta names `Chat`
		const decoded = app.chats.decode_property([{ name: 'decoded' }], 'items');
		assert.lengthOf(decoded, 1);
		assert.instanceOf(decoded[0], MangledChat);
		assert.strictEqual(decoded[0].name, 'decoded');
	});
});
