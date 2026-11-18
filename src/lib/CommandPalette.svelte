<script lang="ts">
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import {
		create_palette_commands,
		filter_palette_commands,
		to_palette_recency,
		type PaletteCommand
	} from './palette_commands.ts';
	import { PALETTE_SHORTCUTS, is_palette_shortcut } from './dashboard_shortcuts.ts';

	/**
	 * The command palette: a filter input over a list of commands
	 * (`palette_commands.ts`), opened by the `palette_toggle` intent
	 * (Ctrl+K or Ctrl+Space). Focus stays in the input, which names the
	 * active command by `aria-activedescendant`, like the file tree names its
	 * active row; Up and Down move it, Enter runs it, a click runs the one
	 * clicked, and Escape, Ctrl+K or Ctrl+Space, or a click outside closes
	 * the palette — through the dialog's own close, which returns the focus.
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

	const commands = $derived(app.ui.show_palette ? create_palette_commands(app) : []);
	const recency = $derived(to_palette_recency(app.recent_intents.entries));
	const matches = $derived(filter_palette_commands(commands, query, recency));
	// the matches can shrink under the active index (a command's state changed) — keep it on one
	const active = $derived(Math.min(active_index, matches.length - 1));

	let list_el: HTMLUListElement | undefined = $state.raw();

	// the active option stays in view as the keyboard moves it
	$effect(() => {
		if (active === -1) return;
		const id = to_option_id(active);
		const el = list_el ? Array.from(list_el.children).find((child) => child.id === id) : undefined;
		// jsdom has no `scrollIntoView`
		el?.scrollIntoView?.({ block: 'nearest' });
	});

	const close = (): void => {
		app.intents.palette_toggle({ show: false });
	};

	const run = (command: PaletteCommand, close_dialog: () => void): void => {
		close_dialog();
		command.run();
	};

	const onkeydown = (e: KeyboardEvent, close_dialog: () => void): void => {
		// the Enter that confirms an input method's text isn't a choice
		if (e.isComposing) return;
		// the input is a text field, which the dashboard's shortcuts leave alone, so the chord that
		// opened the palette closes it here — and never reaches the browser's own Ctrl+K
		if (is_palette_shortcut(e)) {
			swallow(e);
			if (!e.repeat) close_dialog();
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

{#if app.ui.show_palette}
	<Dialog onclose={close} align="top">
		{#snippet children(dialog)}
			<DialogContent close_button={false} class="width:100%">
				<input
					type="text"
					bind:value={query}
					oninput={() => {
						active_index = 0;
					}}
					onkeydown={(e) => onkeydown(e, dialog.close)}
					role="combobox"
					aria-label="command"
					aria-expanded="true"
					aria-controls={listbox_id}
					aria-autocomplete="list"
					aria-activedescendant={active === -1 ? undefined : to_option_id(active)}
					placeholder="run a command [{PALETTE_SHORTCUTS}]"
					autocomplete="off"
					spellcheck="false"
					class="width:100%"
					{@attach (el) => {
						// each opening starts afresh: this component stays mounted while the palette's closed
						query = '';
						active_index = 0;
						el.focus();
					}}
				/>
				<!-- a press on the list keeps the focus in the input, which keeps the keys -->
				<ul
					bind:this={list_el}
					id={listbox_id}
					role="listbox"
					aria-label="commands"
					class="command-palette-list unstyled"
					onmousedown={(e) => e.preventDefault()}
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
					<p class="px_md py_xs text_50">[no matching commands]</p>
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
