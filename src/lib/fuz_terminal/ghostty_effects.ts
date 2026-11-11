/**
 * Effects: the callbacks through which a libghostty-vt terminal asks its host
 * for what it can't do itself — reply to the program (`write_pty`), ring the
 * bell, announce a new title or working directory, hold the screen still
 * while the program redraws it (`render_hold`).
 *
 * `GhosttyTerminal.set_effect` registers and clears them; this module holds
 * what they share. Each effect has **one trampoline per module instance**, a
 * slot in its function table (`GhosttyCallbackTable`) added the first time
 * any terminal registers that effect. The library passes every callback the
 * terminal handle it fired for, and `GhosttyEffectRouter` dispatches on it to
 * the terminal attached under that handle — so the table grows by at most one
 * slot per effect however many terminals come and go. No userdata pointer is
 * set.
 *
 * An effect left unregistered is ignored by the library: a query gets no
 * answer, a bell rings nowhere. That's how output is replayed without
 * answering stale queries — feed it with no `write_pty` registered. The
 * other effects the library has (clipboard read and write, desktop
 * notifications, the size, color-scheme, device-attributes, enquiry, and
 * XTVERSION responders, semantic prompts, unknown sequences, and more)
 * aren't bound, so they're never registered. The clipboard ones stay that
 * way until there's a way to ask the person first.
 *
 * @module
 */

import type { GhosttyCallbackTable } from './ghostty_callback_table.ts';
import { GhosttyManifestError } from './ghostty_errors.ts';
import type { GhosttyManifest } from './ghostty_manifest.ts';
import type { WasmFunctionSignature } from './wasm_trampoline.ts';

/**
 * The handler for each effect a terminal can register. Each runs
 * synchronously, in the middle of the `GhosttyTerminal.write` (or `resize`)
 * that fired it, so it must be quick. It may read the terminal
 * (`GhosttyTerminal.format_text`), but writing, resizing, disposing, or
 * changing effects on the same terminal throws `GhosttyReentrancyError`. An
 * exception it throws is caught, and surfaces from the method that fired it
 * once that call has finished. Its return value is ignored — a promise
 * included, so an async handler must catch its own errors, or its rejection
 * goes unhandled.
 */
export interface GhosttyTerminalEffectHandlers {
	/**
	 * A reply for the program — to a cursor position or device status
	 * report, a device attributes query, a mode query — to be written to the
	 * PTY in order. `data` is a copy the handler may keep.
	 */
	write_pty: (data: Uint8Array) => void;
	/** The program rang the bell (BEL). */
	bell: () => void;
	/**
	 * The program set the title (OSC 0 or 2). `title` is decoded as UTF-8,
	 * invalid sequences replaced; it's program output, so render it as text.
	 */
	title_changed: (title: string) => void;
	/**
	 * The program reported its working directory (OSC 7, OSC 9, OSC 1337
	 * CurrentDir), or cleared it (`''`). `pwd` is what it sent, decoded as
	 * UTF-8 (invalid sequences replaced) but not percent-decoded or parsed —
	 * for OSC 7 a `file://` URI, otherwise usually a bare path.
	 */
	pwd_changed: (pwd: string) => void;
	/**
	 * A render hold began (`held` is `true`: the program set synchronized
	 * output, mode 2026, to redraw without being seen halfway) or ended
	 * (`false`: the program reset the mode, the terminal was fully reset, or
	 * it was resized). The library reports only real changes — setting the
	 * mode during a hold, or resetting it without one, fires nothing — so
	 * `true` and `false` alternate. A handler registered during a hold sees
	 * its end without its beginning, and a terminal disposed during one never
	 * reports its end: a renderer tracks the hold itself and drops it with
	 * the terminal. When a hold begins the
	 * terminal holds exactly the frame the program wants left on screen —
	 * nothing after the mode set has been parsed yet, even later bytes of the
	 * same write — so a renderer updates its `GhosttyRenderState` here, then
	 * leaves it alone until the hold ends. The terminal has no clock and never
	 * ends a hold itself: a renderer that sees one last too long (a second is
	 * usual) stops honoring it and updates again.
	 */
	// TODO: ending a stuck hold the way the library suggests — resetting the
	// mode through `GHOSTTY_TERMINAL_OPT_MODE` — needs that option bound
	render_hold: (held: boolean) => void;
}

/** An effect `GhosttyTerminal.set_effect` takes. */
export type GhosttyTerminalEffectName = keyof GhosttyTerminalEffectHandlers;

/** What the binding knows of one effect: where the library takes it, and what it's called with. */
export interface GhosttyTerminalEffectSpec {
	/** Its `GhosttyTerminalOption` name without the prefix. */
	option: string;
	/** The callback typedef the option takes, as the manifest names it. */
	callback: string;
	/**
	 * The callback's parameters after the terminal and userdata, which the
	 * terminal's receiver reads by position: manifest type names, with
	 * `size_t` standing for the target's (`GhosttyManifest.usize_scalar`).
	 * The manifest gives the signature; this pins it to what the receiver
	 * reads, compared before the types are lowered to wasm ones — so a
	 * pointer and a length swapped is refused, not read the wrong way round.
	 */
	args: ReadonlyArray<string>;
}

/**
 * The effects the binding registers. Binding another is an entry here, a
 * handler type in `GhosttyTerminalEffectHandlers`, and a case in the
 * terminal's receiver.
 */
export const GHOSTTY_TERMINAL_EFFECTS: Readonly<
	Record<GhosttyTerminalEffectName, GhosttyTerminalEffectSpec>
> = {
	write_pty: {
		option: 'WRITE_PTY',
		callback: 'GhosttyTerminalWritePtyFn',
		args: ['pointer', 'size_t']
	},
	bell: { option: 'BELL', callback: 'GhosttyTerminalBellFn', args: [] },
	title_changed: { option: 'TITLE_CHANGED', callback: 'GhosttyTerminalTitleChangedFn', args: [] },
	pwd_changed: { option: 'PWD_CHANGED', callback: 'GhosttyTerminalPwdChangedFn', args: [] },
	render_hold: {
		option: 'RENDER_HOLD',
		callback: 'GhosttyTerminalRenderHoldFn',
		args: ['bool']
	}
	// TODO: the responders (size, color scheme, device attributes) return a
	// bool and fill an out struct; enquiry and XTVERSION return a
	// `GhosttyString` by value, which the wasm C ABI returns through a hidden
	// pointer parameter — each needs more than a void receiver
};

/** One effect's option and callback signature, resolved from the manifest. */
export interface GhosttyEffectConstant {
	/** The `GhosttyTerminalOption` value it's registered under. */
	option: number;
	/** The wasm signature of its callback: the terminal, the userdata, then its args. */
	signature: WasmFunctionSignature;
}

/** The manifest constants the effects use, resolved once per module. */
export interface GhosttyEffectConstants {
	/** Each effect's option and signature. */
	effects: Readonly<Record<GhosttyTerminalEffectName, GhosttyEffectConstant>>;
	/** `GHOSTTY_TERMINAL_DATA_TITLE`. */
	data_title: number;
	/** `GHOSTTY_TERMINAL_DATA_PWD`. */
	data_pwd: number;
	/** `sizeof(GhosttyString)`. */
	string_size: number;
	/** The offset of `GhosttyString.ptr`. */
	string_ptr_offset: number;
	/** The offset of `GhosttyString.len` (a `size_t`). */
	string_len_offset: number;
}

/**
 * Resolve the effects' constants from a manifest, checking each callback
 * typedef has the shape its receiver reads: the terminal handle, a userdata
 * pointer, the spec's args, and no return value.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_effect_constants = (
	manifest: GhosttyManifest
): GhosttyEffectConstants => {
	const effects = {} as Record<GhosttyTerminalEffectName, GhosttyEffectConstant>;
	for (const [name, spec] of Object.entries(GHOSTTY_TERMINAL_EFFECTS) as Array<
		[GhosttyTerminalEffectName, GhosttyTerminalEffectSpec]
	>) {
		const key = manifest.enum_key('GhosttyTerminalOption', spec.option, 'in');
		if (key.type !== spec.callback) {
			throw new GhosttyManifestError(
				`the manifest's GhosttyTerminalOption.${spec.option} takes ${key.type}, not ${spec.callback}`
			);
		}
		const callback = manifest.callback(spec.callback);
		const [terminal, userdata, ...rest] = callback.params;
		const expected = spec.args.map((type) => (type === 'size_t' ? manifest.usize_scalar : type));
		if (
			terminal !== 'GhosttyTerminal' ||
			userdata !== 'pointer' ||
			callback.returns !== 'void' ||
			rest.join(',') !== expected.join(',')
		) {
			throw new GhosttyManifestError(
				`the manifest's ${spec.callback} is (${callback.params.join(', ')}) -> ${callback.returns}, but the binding reads (GhosttyTerminal, pointer${expected.map((type) => `, ${type}`).join('')}) -> void`
			);
		}
		effects[name] = {
			option: manifest.enum_value('GhosttyTerminalOption', spec.option),
			signature: {
				params: [terminal, userdata, ...rest].map((type) => manifest.wasm_value_type(type)),
				results: []
			}
		};
	}
	for (const data of ['TITLE', 'PWD']) {
		const key = manifest.enum_key('GhosttyTerminalData', data, 'out');
		if (key.type !== 'GhosttyString') {
			throw new GhosttyManifestError(
				`the manifest's GhosttyTerminalData.${data} gives ${key.type}, not GhosttyString`
			);
		}
	}
	const ptr = manifest.struct_field('GhosttyString', 'ptr');
	const len = manifest.struct_field('GhosttyString', 'len');
	if (ptr.type !== 'pointer' || ptr.size !== manifest.abi.pointer_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.ptr is not a pointer");
	}
	if (len.type !== manifest.usize_scalar || len.size !== manifest.abi.usize_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.len is not a size_t");
	}
	return {
		effects,
		data_title: manifest.enum_value('GhosttyTerminalData', 'TITLE'),
		data_pwd: manifest.enum_value('GhosttyTerminalData', 'PWD'),
		string_size: manifest.struct_size('GhosttyString'),
		string_ptr_offset: ptr.offset,
		string_len_offset: len.offset
	};
};

/**
 * What the router hands a terminal's effect callback: the effect, and the
 * callback's arguments after the terminal and userdata. It must never throw.
 */
export type GhosttyEffectReceiver = (
	effect: GhosttyTerminalEffectName,
	args: ReadonlyArray<number>
) => void;

/**
 * One module instance's effect trampolines, and the terminals they dispatch
 * to by handle. `GhosttyVt.effect_router` is its instance's; terminals
 * attach themselves at creation and detach at dispose, before their handle is
 * freed, so a callback never reaches a disposed terminal.
 */
export class GhosttyEffectRouter {
	readonly #callbacks: GhosttyCallbackTable;
	readonly #resolve: () => GhosttyEffectConstants;
	readonly #receivers: Map<number, GhosttyEffectReceiver> = new Map();
	/** Each effect's trampoline slot, added on first use and kept for the instance's life. */
	readonly #indexes: Map<GhosttyTerminalEffectName, number> = new Map();

	/**
	 * @param callbacks - the instance's function table slots
	 * @param resolve - the instance's effect constants, resolved on first use
	 */
	constructor(callbacks: GhosttyCallbackTable, resolve: () => GhosttyEffectConstants) {
		this.#callbacks = callbacks;
		this.#resolve = resolve;
	}

	/** How many terminals are attached. */
	get attached_count(): number {
		return this.#receivers.size;
	}

	/**
	 * Route callbacks for the terminal handle `terminal` to `receiver`.
	 *
	 * @throws Error when a terminal is already attached under that handle
	 */
	attach(terminal: number, receiver: GhosttyEffectReceiver): void {
		if (this.#receivers.has(terminal)) {
			throw new Error(`a terminal is already attached under handle ${terminal}`);
		}
		this.#receivers.set(terminal, receiver);
	}

	/** Stop routing callbacks for `terminal`; a callback for it is then ignored. */
	detach(terminal: number): void {
		this.#receivers.delete(terminal);
	}

	/**
	 * The function pointer to register `effect` with: its trampoline's table
	 * slot, added the first time it's asked for.
	 *
	 * @throws GhosttyManifestError when the manifest lacks the effects' entries
	 */
	callback_index(effect: GhosttyTerminalEffectName): number {
		let index = this.#indexes.get(effect);
		if (index === undefined) {
			const { signature } = this.#resolve().effects[effect];
			index = this.#callbacks.add(
				(terminal: number, _userdata: number, ...args: Array<number>): void =>
					this.#route(effect, terminal >>> 0, args),
				signature
			);
			this.#indexes.set(effect, index);
		}
		return index;
	}

	#route(effect: GhosttyTerminalEffectName, terminal: number, args: Array<number>): void {
		// a handle with no receiver is a terminal being freed (it detaches
		// first): nothing to tell
		const receiver = this.#receivers.get(terminal);
		if (!receiver) return;
		try {
			receiver(effect, args);
		} catch {
			// receivers catch their own errors; this is the backstop that keeps
			// an exception from ever unwinding through the library's frames
		}
	}
}
