<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import {
		create_palette_commands,
		create_palette_file_commands,
		to_palette_file_entries,
		type PaletteMode,
		filter_palette_commands,
		to_palette_recency,
		type PaletteCommand
	} from './palette_commands.ts';
	import {
		PALETTE_SHORTCUTS,
		is_key_composing,
		is_palette_shortcut
	} from './dashboard_shortcuts.ts';

	/**
	 * The command palette: a filter input over a list of commands
	 * (`palette_commands.ts`), opened by the `palette_toggle` intent
	 * (Ctrl+K or Ctrl+Space). Focus stays in the input, which names the
	 * active command by `aria-activedescendant`, like the file tree names its
	 * active row; Up and Down move it, Enter runs it, a click runs the one
	 * clicked, and Escape, Ctrl+K or Ctrl+Space, or a click outside closes
	 * the palette — through the dialog's own close, which returns the focus,
	 * as does the intent closing it from code (`palette_toggle {show: false}`).
	 *
	 * Running a command closes the palette first — the native dialog's close
	 * returns focus to where it was — so the command acts on the page as the
	 * user left it, and lands in the recent intents after the close.
	 *
	 * @module
	 */

	const app = frontend_context.get();

	const id_prefix = $props.id();
	const listbox_id = `${id_prefix}-commands`;
	const to_option_id = (index: number): string => `${id_prefix}-command-${index}`;

	let query = $state('');
	let active_index = $state(0);
	let mode = $state<PaletteMode>('commands');

	const commands = $derived(
		app.ui.show_palette && mode === 'commands'
			? create_palette_commands(app, page.url.pathname)
			: []
	);
	const recency = $derived(to_palette_recency(app.recent_intents.entries));
	// made once per index change, so a keystroke only filters
	const file_entries = $derived(
		app.ui.show_palette && mode === 'files' ? to_palette_file_entries(app) : null
	);
	const files = $derived(
		file_entries ? create_palette_file_commands(app, file_entries, query, page.url.pathname) : null
	);
	const matches = $derived(
		files ? files.commands : filter_palette_commands(commands, query, recency)
	);
	// the matches can shrink under the active index (a command's state changed) — keep it on one
	const active = $derived(Math.min(active_index, matches.length - 1));

	let list_el: HTMLUListElement | undefined = $state.raw();
	let input_el: HTMLInputElement | undefined = $state.raw();

	// new results start at the top, not wherever the old ones were scrolled to — the active row's
	// scroll into view doesn't run when it was the first already
	const reset_list = (): void => {
		active_index = 0;
		if (list_el) list_el.scrollTop = 0;
	};

	// the active option stays in view as the keyboard moves it
	$effect(() => {
		if (active === -1) return;
		const id = to_option_id(active);
		const el = list_el ? Array.from(list_el.children).find((child) => child.id === id) : undefined;
		// jsdom has no `scrollIntoView`
		el?.scrollIntoView?.({ block: 'nearest' });
	});

	// the open dialog's own close, which the intent closing the palette from code goes through:
	// unmounting closes the native dialog detached, which returns no focus, so the dialog shows
	// while `shown` does, cleared only after that close ran — whatever order the intent's caller
	// (an event handler, another component's effect) puts it in against the markup's update
	let open_dialog_close: (() => void) | null = null;
	let shown = $state.raw(false);
	$effect.pre(() => {
		if (app.ui.show_palette) {
			shown = true;
		} else {
			untrack(() => open_dialog_close?.());
			shown = false;
		}
	});

	// the dialog closed — by Escape, a click outside, a chord, a command, or the intent from code
	const onclose = (): void => {
		open_dialog_close = null;
		if (app.ui.show_palette) app.intents.palette_toggle({ show: false });
	};

	const run = (command: PaletteCommand, close_dialog: () => void): void => {
		if (command.mode) {
			// a switch of what the palette lists keeps it open, starting afresh
			mode = command.mode;
			query = '';
			reset_list();
			return;
		}
		close_dialog();
		command.run();
	};

	const onkeydown = (e: KeyboardEvent, close_dialog: () => void): void => {
		// an input method's keys are its own: the Enter that confirms its text isn't a choice, and its
		// Ctrl+Space switch doesn't close the palette
		if (is_key_composing(e)) return;
		// the dashboard's shortcuts leave the chord to the open palette, which closes here — and it
		// never reaches the browser's own Ctrl+K
		if (is_palette_shortcut(e)) {
			swallow(e);
			if (!e.repeat) close_dialog();
			return;
		}
		// Backspace in an empty file filter goes back to the commands
		if (e.key === 'Backspace' && mode === 'files' && !query) {
			swallow(e);
			// a held Backspace that emptied the filter stops there
			if (e.repeat) return;
			mode = 'commands';
			reset_list();
			return;
		}
		if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
		const count = matches.length;
		switch (e.key) {
			case 'ArrowDown':
				if (count) active_index = (active + 1) % count;
				break;
			case 'ArrowUp':
				if (count) active_index = (active - 1 + count) % count;
				break;
			case 'Enter': {
				const command = matches[active];
				if (!command) return;
				swallow(e);
				run(command, close_dialog);
				return;
			}
			default:
				return;
		}
		swallow(e);
	};
</script>

{#if shown}
	<Dialog {onclose} align="top">
		{#snippet children(dialog)}
			<!-- a press anywhere on the palette but its input keeps the focus in the input, which keeps
			the keys — a click on a row runs it, one on the padding or a note does nothing -->
			<DialogContent
				close_button={false}
				class="width:100%"
				onmousedown={(e) => {
					if (e.target !== input_el) e.preventDefault();
				}}
			>
				<input
					bind:this={input_el}
					type="text"
					bind:value={query}
					oninput={reset_list}
					onkeydown={(e) => onkeydown(e, dialog.close)}
					role="combobox"
					aria-label={mode === 'files' ? 'file' : 'command'}
					aria-expanded="true"
					aria-controls={listbox_id}
					aria-autocomplete="list"
					aria-activedescendant={active === -1 ? undefined : to_option_id(active)}
					placeholder={mode === 'files'
						? 'go to a file — Backspace for the commands'
						: `run a command [${PALETTE_SHORTCUTS}]`}
					autocomplete="off"
					spellcheck="false"
					class="width:100%"
					{@attach (el) => {
						// each opening starts afresh: this component stays mounted while the palette's closed
						query = '';
						active_index = 0;
						mode = 'commands';
						open_dialog_close = dialog.close;
						el.focus();
					}}
				/>
				<ul
					bind:this={list_el}
					id={listbox_id}
					role="listbox"
					aria-label={mode === 'files' ? 'files' : 'commands'}
					class="command-palette-list unstyled"
				>
					{#each matches as command, index (command.key)}
						<!-- the input keeps the focus and the keys; a click runs the command -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<li
							id={to_option_id(index)}
							role="option"
							aria-selected={index === active}
							class="menuitem sized_sm"
							class:selected={index === active}
							onmousemove={() => {
								active_index = index;
							}}
							onclick={() => run(command, dialog.close)}
						>
							{command.label}
						</li>
					{/each}
				</ul>
				{#if !matches.length}
					<p class="px_md py_xs text_50">
						{mode === 'files' ? '[no matching files]' : '[no matching commands]'}
					</p>
				{:else if files && files.total > files.commands.length}
					<p class="px_md py_xs text_50" role="status">
						the first {files.commands.length} of {files.total} files — type to narrow them
					</p>
				{/if}
			</DialogContent>
		{/snippet}
	</Dialog>
{/if}

<style>
	.command-palette-list {
		max-height: 60svh;
		overflow: auto;
		scrollbar-width: thin;
	}
</style>
