<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';
	import CodeTextarea from '@fuzdev/fuz_code/CodeTextarea.svelte';

	import { handle_save_shortcut_keydown, type SaveShortcutScope } from './save_shortcut.ts';

	/**
	 * A basic source editor: fuz_code's `CodeTextarea`, a textarea highlighted
	 * as `lang`, plus the editors' save shortcut and focus handling. The
	 * primitive richer editing builds on — stats, clear / restore, and paste
	 * stay `ContentEditor`'s.
	 *
	 * @module
	 */

	let {
		value = $bindable(),
		lang = null,
		readonly = false,
		placeholder,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		onsave,
		save_shortcut = 'focused',
		attrs,
		wrapper_attrs
	}: {
		/** The source text. */
		value: string;
		/**
		 * The fuz_code language to highlight as — a language registered on
		 * `syntax_styler_global`, like `lang_for_path` returns; `null` disables
		 * highlighting.
		 */
		lang?: string | null | undefined;
		readonly?: boolean | undefined;
		placeholder?: string | null | undefined;
		/** Focuses the textarea when `pending_element_to_focus_key` equals it, then clears that. */
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		/** Called with the value on Ctrl+S / Cmd+S — see `save_shortcut`. */
		onsave?: ((value: string) => void) | undefined;
		/** Where Ctrl+S / Cmd+S triggers `onsave` — see `SaveShortcutScope`. */
		save_shortcut?: SaveShortcutScope | undefined;
		/** Attributes for the `<textarea>`. */
		attrs?: SvelteHTMLElements['textarea'] | undefined;
		/** Attributes for `CodeTextarea`'s wrapper `<div>`, the box the textarea fills. */
		wrapper_attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let textarea_el: HTMLTextAreaElement | undefined = $state.raw();

	/**
	 * Focus the textarea element - exposed for parent components.
	 */
	export const focus = (): void => {
		textarea_el?.focus();
	};

	/**
	 * Focus the textarea with the caret at `offset` (clamped to the source),
	 * scrolled to its top row (as near as the scroll range allows) - exposed for
	 * parent components, like an outline.
	 */
	export const place_caret = (offset: number): void => {
		const el = textarea_el;
		if (!el) return;
		const clamped = Math.max(0, Math.min(offset, el.value.length));
		// browsers scroll a textarea to its caret when it takes focus, not on `setSelectionRange`,
		// and only as far as it takes - so start from the bottom, and the caret lands on the top row
		if (document.activeElement === el) el.blur();
		el.setSelectionRange(clamped, clamped);
		el.scrollTop = el.scrollHeight;
		el.focus();
	};

	// the textarea's own handler runs first and swallows the event, so a page-level listener never
	// saves a different editor than the focused one
	const handle_save_shortcut = (event: KeyboardEvent): void => {
		handle_save_shortcut_keydown(event, onsave && (() => onsave(value)));
	};
</script>

<svelte:document
	onkeydown={onsave && save_shortcut === 'page' ? handle_save_shortcut : undefined}
/>

<!-- attachments on `CodeTextarea` pass through its rest props to the `<textarea>` -->
<CodeTextarea
	{...attrs}
	bind:value
	{lang}
	{readonly}
	{placeholder}
	{wrapper_attrs}
	onkeydown={(event) => {
		attrs?.onkeydown?.(event);
		handle_save_shortcut(event);
	}}
	{@attach (el: HTMLTextAreaElement) => {
		textarea_el = el;
		return () => {
			textarea_el = undefined;
		};
	}}
	{@attach focus_key == null
		? null
		: (el: HTMLTextAreaElement) => {
				if (focus_key === pending_element_to_focus_key) {
					pending_element_to_focus_key = null;
					el.focus();
				}
			}}
/>
