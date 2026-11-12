<script lang="ts">
	// One view of a terminal cell's process: a `FuzTerminal` fed the cell's
	// output, its keys and replies sent back as input, its size the PTY's — see
	// `TerminalViewLink`. Unmounting detaches the view; the process keeps running.
	//
	// The host gives it a definite height (it fills its parent). The emulator
	// fills `.terminal-box`, which is positioned over `.terminal-screen`, a flex
	// item stretched in this column, so its box has a size by construction.
	import { untrack } from 'svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import FuzTerminal from './fuz_terminal/FuzTerminal.svelte';
	import type { FuzTerminalStatus } from './fuz_terminal/fuz_terminal_state.svelte.ts';
	import { load_fuz_terminal_module } from './fuz_terminal_module.ts';
	import type { Terminal } from './terminal.svelte.ts';
	import { paste_terminal_text, type TerminalPasteOutcome } from './terminal_paste.ts';
	import { TerminalViewLink } from './terminal_view_link.ts';

	const {
		terminal,
		get_text,
		get_paste,
		confirm_paste = (message) => confirm(message), // eslint-disable-line no-alert
		load_module = load_fuz_terminal_module
	}: {
		terminal: Terminal;
		get_text?: (fn: () => string) => void;
		/**
		 * Hands the parent the view's paste: give it a clipboard read started
		 * from the user's gesture (`read_clipboard_text`); a failure is shown
		 * in the view, never thrown.
		 */
		get_paste?: (fn: (text: Promise<string>) => Promise<TerminalPasteOutcome>) => void;
		/** Asks whether to paste text that could inject commands; defaults to `confirm`. */
		confirm_paste?: (message: string) => boolean;
		/** The compiled emulator module's loader; defaults to the page's shared one. */
		load_module?: () => Promise<WebAssembly.Module>;
	} = $props();

	let view: FuzTerminal | undefined = $state.raw();
	let link: TerminalViewLink | null = null;
	let status: FuzTerminalStatus = $state.raw({ kind: 'loading' });
	let copy_text: string = $state.raw('');
	/** Why the last paste failed, until the next paste that doesn't fail, or it's dismissed. */
	let paste_notice: string | null = $state.raw(null);
	/**
	 * Bumped to remount the emulator — a fresh instance, the cell's history
	 * replayed into it: "reopen" for a poisoned view, "retry" for a failed one.
	 */
	let generation = $state(0);

	const get_terminal_text = (): string => view?.get_text() ?? '';

	// read the screen only when copying — `CopyToClipboard` reads its `text`
	// prop after calling `onclick`, and props are live, so it copies this fresh value
	const refresh_copy_text = (): void => {
		copy_text = get_terminal_text();
	};

	untrack(() => get_text)?.(get_terminal_text);

	const paste = async (text: Promise<string>): Promise<TerminalPasteOutcome> => {
		const outcome = await paste_terminal_text(text, {
			paste: (pasted, options) =>
				view?.paste(pasted, options) ?? { kind: 'unavailable', reason: 'not_ready' },
			input_room: () => terminal.input_room,
			confirm: (message) => confirm_paste(message)
		});
		if (outcome.kind === 'failed') {
			paste_notice = outcome.message;
		} else {
			paste_notice = null;
			// typing goes on where the text went
			if (outcome.kind === 'pasted') view?.focus();
		}
		return outcome;
	};

	untrack(() => get_paste)?.(paste);

	// link each emulator instance as soon as it's mounted, so its writes queue
	// while its module loads; a remount links the new one. Only the instance is
	// tracked: connecting writes to the view, which reads its status
	$effect(() => {
		const mounted = view;
		if (!mounted) return;
		const next = untrack(() => {
			const created = new TerminalViewLink(terminal);
			created.connect(mounted);
			return created;
		});
		link = next;
		return () => {
			next.disconnect();
			if (link === next) link = null;
		};
	});

	// what `send_input` takes bytes for: off, the view leaves keys to the
	// browser (Tab moves focus on) rather than taking them only to drop them
	const accepts_input = $derived(terminal.status === 'running' || terminal.status === 'starting');

	const reopen = (): void => {
		status = { kind: 'loading' };
		generation++;
	};
</script>

<div class="terminal-view">
	<div class="terminal-header">
		<span class="terminal-id">terminal {terminal.terminal_id?.slice(0, 8) ?? '…'}</span>
		<div class="terminal-actions">
			{#if status.kind === 'poisoned'}
				<button type="button" onclick={reopen} title="reopen the terminal view">reopen</button>
			{:else if status.kind === 'failed'}
				<!-- a failed module load isn't kept, so this loads it again -->
				<button type="button" onclick={reopen} title="retry loading the terminal view">
					retry
				</button>
			{/if}
			<CopyToClipboard
				text={copy_text}
				allow_copying_empty_string
				disabled={status.kind !== 'ready'}
				onclick={refresh_copy_text}
				class="plain"
			/>
			<button
				type="button"
				onclick={() => terminal.close()}
				disabled={!terminal.running || terminal.closing}
			>
				{terminal.closing ? 'closing…' : 'close'}
			</button>
		</div>
	</div>
	{#if terminal.output_gap && terminal.running}
		<p class="output-gap" role="status">
			<small>connection lost — some output may be missing</small>
			<button type="button" class="plain" onclick={() => (terminal.output_gap = false)}>
				dismiss
			</button>
		</p>
	{/if}
	{#if paste_notice}
		<p class="paste-notice" role="alert">
			<small>{paste_notice}</small>
			<button type="button" class="plain" onclick={() => (paste_notice = null)}>dismiss</button>
		</p>
	{/if}
	<div class="terminal-screen">
		<div class="terminal-box">
			{#key generation}
				<FuzTerminal
					bind:this={view}
					module={load_module()}
					label="terminal: {terminal.display_command}"
					{accepts_input}
					ondata={(data) => link?.send(data)}
					onresize={(size) => link?.resize(size)}
					onstatus={(next) => {
						status = next;
						link?.view_status_changed();
					}}
				/>
			{/key}
		</div>
	</div>
</div>

<style>
	.terminal-view {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.terminal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space_xs);
		background: var(--ink_10);
	}
	.terminal-id {
		font-size: var(--font_size_sm);
		opacity: 0.7;
	}
	.terminal-actions {
		display: flex;
		gap: var(--space_xs);
		align-items: center;
	}
	.output-gap,
	.paste-notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space_sm);
		margin: 0;
		padding: var(--space_xs3) var(--space_xs);
		background: var(--ink_10);
	}
	/* takes what the header and notice leave; `min-height: 0` lets it shrink
	below its content */
	.terminal-screen {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	/* laid over the item absolutely, so its size is the item's, never its
	content's — a definite box for the emulator, which fills it */
	.terminal-box {
		position: absolute;
		inset: 0;
	}
</style>
