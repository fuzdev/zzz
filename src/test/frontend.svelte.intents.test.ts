// @vitest-environment jsdom

import { test, describe, afterEach, assert, vi } from 'vitest';
import { flushSync } from 'svelte';
import { jsonrpc_errors } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { all_action_specs, all_intent_specs } from '#lib/action_specs.ts';
import { is_intent_action_spec } from '#lib/intent_spec.ts';
import { Frontend, type FrontendOptions } from '#lib/frontend.svelte.ts';
import { RecentIntents } from '#lib/recent_intents.svelte.ts';
import { create_frontend_action_handlers } from '#lib/frontend_action_handlers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { run_in_effect } from './reactive_test_helpers.svelte.ts';

let app: Frontend | undefined;

const create_app = (options?: FrontendOptions): Frontend => {
	const created = monkeypatch_zzz_for_tests(new Frontend(options));
	app = created;
	return created;
};

afterEach(() => {
	app?.dispose();
	app = undefined;
});

describe('the intent roster', () => {
	test('every `local_call` spec is an intent, and every intent a `local_call`', () => {
		const local_calls = all_action_specs.filter((spec) => spec.kind === 'local_call');
		assert.deepEqual(
			local_calls.map((spec) => spec.method).sort(),
			all_intent_specs.map((spec) => spec.method).sort()
		);
		for (const spec of local_calls) {
			assert.ok(is_intent_action_spec(spec), spec.method);
			assert.ok(Number.isInteger(spec.version) && spec.version >= 1, spec.method);
			assert.strictEqual(spec.async, false, spec.method);
			assert.strictEqual(spec.initiator, 'frontend', spec.method);
		}
	});

	test('a spec without a version or history is not an intent', () => {
		const [intent] = all_intent_specs;
		assert.ok(intent);
		const { version: _version, ...no_version } = intent;
		const { history: _history, ...no_history } = intent;
		assert.ok(!is_intent_action_spec(no_version));
		assert.ok(!is_intent_action_spec(no_history));
	});
});

describe('app.intents', () => {
	test('applies the change before it returns', () => {
		const app = create_app();
		assert.strictEqual(app.ui.show_main_dialog, false);
		assert.deepEqual(app.intents.main_menu_toggle(), { show: true });
		assert.strictEqual(app.ui.show_main_dialog, true);
		assert.deepEqual(app.intents.main_menu_toggle({ show: true }), { show: true });
		assert.deepEqual(app.intents.main_menu_toggle({ show: false }), { show: false });
		assert.strictEqual(app.ui.show_main_dialog, false);
	});

	test('records each call in `recent_intents`, not in the actions log', () => {
		const app = create_app();
		app.intents.main_menu_toggle({ show: true });
		app.intents.main_menu_toggle();
		const entries = app.recent_intents.entries;
		assert.strictEqual(entries.length, 2);
		const [first, second] = entries;
		assert.ok(first && second);
		assert.strictEqual(first.method, 'main_menu_toggle');
		assert.strictEqual(first.version, 1);
		assert.strictEqual(first.history, 'layout');
		assert.strictEqual(first.outcome, 'applied');
		assert.deepEqual(first.input, { show: true });
		assert.strictEqual(first.inverse, null);
		assert.ok(second.seq > first.seq);
		assert.strictEqual(app.actions.items.size, 0);
	});

	test('a call whose input fails to parse throws and is recorded as failed', () => {
		const app = create_app();
		assert.throws(() => app.intents.main_menu_toggle({ show: 'yes' } as never));
		const [entry] = app.recent_intents.entries;
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'failed');
		assert.ok(entry.error);
		assert.strictEqual(app.ui.show_main_dialog, false);
	});

	test('input that fails its schema is not kept', () => {
		const app = create_app();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.throws(() => app.intents.main_menu_toggle(cyclic));
		const [entry] = app.recent_intents.entries;
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'failed');
		assert.strictEqual(entry.input, null);
	});

	test('a handler that refuses its input as `invalid_params` keeps the parsed input', () => {
		const handlers = create_frontend_action_handlers(null as never);
		const app = create_app({
			action_handlers: {
				...handlers,
				main_menu_toggle: {
					execute: () => {
						throw jsonrpc_errors.invalid_params('not now');
					}
				}
			}
		});
		assert.throws(() => app.intents.main_menu_toggle({ show: true }));
		const [entry] = app.recent_intents.entries;
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'failed');
		assert.deepEqual(entry.input, { show: true });
	});

	test('output that fails its schema throws after the change applied, recorded once as failed', () => {
		const handlers = create_frontend_action_handlers(null as never);
		const app = create_app({
			action_handlers: {
				...handlers,
				main_menu_toggle: {
					execute: () => {
						app.ui.toggle_main_menu(true);
						return { show: 'yes' } as never;
					}
				}
			}
		});
		assert.throws(() => app.intents.main_menu_toggle());
		assert.strictEqual(app.ui.show_main_dialog, true);
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => entry.outcome),
			['failed']
		);
	});

	test('an intent called inside another warns in development', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const handlers = create_frontend_action_handlers(null as never);
			const app = create_app({
				action_handlers: {
					...handlers,
					main_menu_toggle: {
						execute: ({ data: { input } }) => {
							if (input?.show === undefined) app.intents.main_menu_toggle({ show: true });
							return { show: app.ui.show_main_dialog };
						}
					}
				}
			});
			app.intents.main_menu_toggle();
			assert.strictEqual(warn.mock.calls.length, 1);
			app.intents.main_menu_toggle({ show: false });
			assert.strictEqual(warn.mock.calls.length, 1);
		} finally {
			warn.mockRestore();
		}
	});

	test('a handler that throws is recorded as failed', () => {
		const app = create_app({
			action_handlers: (() => {
				const handlers = create_frontend_action_handlers(null as never);
				return {
					...handlers,
					main_menu_toggle: {
						execute: () => {
							throw new Error('broken');
						}
					}
				};
			})()
		});
		assert.throws(() => app.intents.main_menu_toggle());
		const [entry] = app.recent_intents.entries;
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'failed');
	});

	test('an intent is not callable through `app.api`, nor an RPC through `app.intents`', () => {
		const app = create_app();
		assert.ok(!('main_menu_toggle' in app.api));
		assert.ok(!('ping' in app.intents));
		assert.ok('ping' in app.api);
		assert.ok('main_menu_toggle' in app.intents);
	});

	test('a call inside an `$effect` does not make it depend on the buffer', () => {
		const app = create_app();
		let runs = 0;
		const cleanup = run_in_effect(() => {
			runs++;
			app.intents.main_menu_toggle({ show: false });
		});
		flushSync();
		app.intents.main_menu_toggle({ show: false });
		flushSync();
		cleanup();
		// the effect's own call and the outside one both landed, and the outside
		// one didn't re-run the effect
		assert.strictEqual(runs, 1);
		assert.strictEqual(app.recent_intents.entries.length, 2);
	});

	test("a call inside an `$effect` doesn't make it depend on what the handler reads", () => {
		const app = create_app();
		let runs = 0;
		const cleanup = run_in_effect(() => {
			runs++;
			// reads `show_main_dialog` to flip it
			app.intents.main_menu_toggle();
		});
		flushSync();
		cleanup();
		assert.strictEqual(runs, 1);
		assert.strictEqual(app.ui.show_main_dialog, true);
	});
});

describe('RecentIntents', () => {
	test('keeps the newest `limit` entries, oldest first', () => {
		const recent = new RecentIntents(3);
		const [spec] = all_intent_specs;
		assert.ok(spec);
		for (let i = 0; i < 5; i++) recent.record(spec, { show: i % 2 === 0 }, 'applied');
		assert.deepEqual(
			recent.entries.map((entry) => entry.seq),
			[3, 4, 5]
		);
		recent.clear();
		assert.strictEqual(recent.entries.length, 0);
		// seq keeps increasing across a clear
		assert.strictEqual(recent.record(spec, undefined, 'applied').seq, 6);
	});
});
