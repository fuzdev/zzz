import type { ActionSpecUnion, LocalCallActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';
import { DEV } from 'esm-env';
import { untrack } from 'svelte';

import type { FrontendActionsApi, LocalCallActionMethod } from './action_metatypes.ts';

/**
 * What a recent-intents entry is for once undo exists. `layout` intents
 * (open, close, move a tab, toggle a panel) are the undoable ones, each with
 * an inverse; `navigation` intents (select a tab, show a view) belong to
 * back / forward instead; `none` changes nothing worth undoing.
 */
export type IntentHistory = 'layout' | 'navigation' | 'none';

/**
 * A UI intent: a user's action at the grain of open, close, move, select,
 * run, save — never a keystroke, cursor, scroll, or pointer move. Every
 * driver (a click, a shortcut, a test) calls the same spec through
 * `app.intents`.
 *
 * A `local_call` spec with three fields fuz_app doesn't know: `label`,
 * `version`, bumped when the input's meaning changes so a buffered or
 * persisted entry can't be replayed against the wrong shape, and
 * `history`. Specs declare `satisfies IntentActionSpec`; the base type's
 * excess-property check would refuse the extra fields.
 *
 * Most intents are sync: the handler applies the change before the call
 * returns, an expected no-op (the tab is already gone) is reported in the
 * output, and a throw is a bug. An intent that waits on the daemon or the
 * disk (`path_open`, `tab_close_resolve`) is `async`: it applies what it can
 * before its first `await`, returns a `Result`, and is recorded when it
 * settles — an expected failure (the daemon refused the path, the save
 * failed) is the `Result`'s error, recorded `failed` with its message.
 */
export interface IntentActionSpec extends LocalCallActionSpec {
	/**
	 * What the intent is called in the UI — the command palette's entry,
	 * lowercase like the rest of zzz's UI text. A palette entry that binds an
	 * input may name itself more precisely (`palette_commands.ts`).
	 */
	readonly label: string;
	readonly version: number;
	readonly history: IntentHistory;
}

/** The typed intents surface, `app.intents`. */
export type FrontendIntentsApi = Pick<FrontendActionsApi, LocalCallActionMethod>;

/** The typed RPC surface, `app.api` — every action but the intents. */
export type FrontendRpcApi = Omit<FrontendActionsApi, LocalCallActionMethod>;

/**
 * Wraps the intents client so every call runs untracked: an intent is a
 * user's action, never a derivation, so neither its handler's reads nor the
 * recent-intents record may become dependencies of an `$effect` that calls
 * it (`main_menu_toggle()` reads the flag it flips, and would loop one). An
 * async intent's part after its first `await` runs outside any reaction
 * anyway; the nesting warning covers only its sync part.
 *
 * Also warns in development when an intent is called while another runs:
 * a handler changes state through cell methods, never `app.intents`, or one
 * gesture would land in the recent intents twice, inner call first.
 */
export const create_untracked_intents = <T extends object>(intents: T): T => {
	let depth = 0;
	return new Proxy(intents, {
		get: (target, key, receiver) => {
			const value: unknown = Reflect.get(target, key, receiver);
			if (typeof value !== 'function') return value;
			return (...args: Array<unknown>): unknown => {
				if (DEV && depth > 0) {
					console.warn(
						`[intents] \`${String(key)}\` called inside another intent's handler — call cell methods there instead`
					);
				}
				depth++;
				try {
					return untrack(() => (value as (...a: Array<unknown>) => unknown)(...args));
				} finally {
					depth--;
				}
			};
		}
	});
};

/**
 * Whether `spec` is an intent. Every `local_call` spec in zzz is one — a
 * test holds the roster to it, so the `local_call` kind and the intents
 * surface can't drift apart.
 */
export const is_intent_action_spec = (spec: ActionSpecUnion): spec is IntentActionSpec =>
	spec.kind === 'local_call' &&
	typeof (spec as Partial<IntentActionSpec>).label === 'string' &&
	typeof (spec as Partial<IntentActionSpec>).version === 'number' &&
	typeof (spec as Partial<IntentActionSpec>).history === 'string';
