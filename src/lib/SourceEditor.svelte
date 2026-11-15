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
		oncaret,
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
		/**
		 * Called with the caret's offset into `value` as it moves — typing,
		 * clicks, keys, selecting (the moving end of a selection) — and with
		 * `null` when the textarea goes away.
		 */
		oncaret?: ((offset: number | null) => void) | undefined;
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
		emit_caret(el);
	};

	/** The textarea, the element that scrolls - exposed for parent components. */
	export const get_scroll_element = (): HTMLTextAreaElement | undefined => textarea_el;

	let measure_range: Range | undefined;

	/**
	 * The content y of the line holding the character at `offset` (clamped to
	 * the source) — its top and bottom, where a `scrollTop` of `top` puts the
	 * line at the textarea's top edge — or `null` when it can't be measured
	 * (no layout) - exposed for parent components, like scroll sync.
	 */
	export const measure_offset = (offset: number): { top: number; bottom: number } | null => {
		const el = textarea_el;
		// the textarea has no geometry for its text, but `CodeTextarea`'s highlight backdrop - the
		// `pre` before it, holding the same text plus a newline in one text node, with the same box
		// metrics and kept at the same scroll - does
		// TODO this relies on fuz_code internals (the backdrop's class and place); a measuring API on
		// `CodeTextarea` would remove the coupling - until then a change there returns `null`, and
		// scroll sync stops rather than misaligns
		const backdrop = el?.previousElementSibling;
		if (
			!(backdrop instanceof HTMLElement) ||
			!backdrop.classList.contains('code_textarea_backdrop')
		) {
			return null;
		}
		const text = backdrop.firstChild;
		if (!(text instanceof Text) || text.length === 0) return null;
		measure_range ??= document.createRange();
		if (typeof measure_range.getClientRects !== 'function') return null;
		const index = Math.max(0, Math.min(Math.floor(offset), text.length - 1));
		measure_range.setStart(text, index);
		measure_range.setEnd(text, index + 1);
		const rect = measure_range.getClientRects()[0];
		if (!rect || (rect.top === 0 && rect.bottom === 0)) return null;
		const base = backdrop.getBoundingClientRect().top + backdrop.clientTop - backdrop.scrollTop;
		return { top: rect.top - base, bottom: rect.bottom - base };
	};

	let last_caret: number | null = null;

	const emit_caret = (el: HTMLTextAreaElement): void => {
		if (!oncaret) return;
		const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
		if (caret === last_caret) return;
		last_caret = caret;
		oncaret(caret);
	};

	// browsers differ on where a textarea's `selectionchange` fires - the textarea or the document -
	// so these listen to both, and to the events that move the caret; `emit_caret` drops repeats
	const CARET_EVENTS = [
		'selectionchange',
		'select',
		'input',
		'keyup',
		'pointerup',
		'focus'
	] as const;

	const attach_caret = (el: HTMLTextAreaElement): (() => void) => {
		const handle = (): void => emit_caret(el);
		const handle_document = (): void => {
			if (document.activeElement === el) emit_caret(el);
		};
		for (const type of CARET_EVENTS) el.addEventListener(type, handle);
		document.addEventListener('selectionchange', handle_document);
		return () => {
			for (const type of CARET_EVENTS) el.removeEventListener(type, handle);
			document.removeEventListener('selectionchange', handle_document);
			if (last_caret !== null) {
				last_caret = null;
				oncaret?.(null);
			}
		};
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
	{@attach oncaret ? attach_caret : null}
	{@attach focus_key == null
		? null
		: (el: HTMLTextAreaElement) => {
				if (focus_key === pending_element_to_focus_key) {
					pending_element_to_focus_key = null;
					el.focus();
				}
			}}
/>
