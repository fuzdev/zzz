<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {Snippet} from 'svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import PasteFromClipboard from '@fuzdev/fuz_ui/PasteFromClipboard.svelte';
	import {swallow} from '@fuzdev/fuz_util/dom.js';

	import {estimate_token_count} from './helpers.js';
	import ContentStats from './ContentStats.svelte';
	import ClearRestoreButton from './ClearRestoreButton.svelte';
	import {GLYPH_PASTE, GLYPH_PLACEHOLDER} from './glyphs.js';
	import Glyph from './Glyph.svelte';

	let {
		content = $bindable(),
		token_count: token_count_prop,
		placeholder = GLYPH_PLACEHOLDER,
		readonly = false,
		show_stats = false,
		show_actions = false,
		textarea_height,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		attrs, // TODO probably extend base props with SvelteHTMLElements['textarea'] and delete this
		after,
		children,
		onsave,
	}: {
		content: string; // TODO maybe rename to value? rethink `ContentEditor` in general when we switch to CodeMirror
		/** Estimated if not provided and `show_stats` is true. */
		token_count?: number | undefined;
		placeholder?: string | null | undefined;
		readonly?: boolean | undefined;
		show_stats?: boolean | undefined;
		show_actions?: boolean | undefined;
		textarea_height?: string | undefined;
		// TODO @many think about how these two could be refactored, like a single class instance
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		attrs?: SvelteHTMLElements['textarea'] | undefined;
		after?: Snippet | undefined;
		children?: Snippet | undefined;
		onsave?: ((value: string) => void) | undefined;
	} = $props();

	let textarea_el: HTMLTextAreaElement | undefined = $state();

	const token_count = $derived(token_count_prop ?? estimate_token_count(content));

	/**
	 * Focus the textarea element - exposed for parent components.
	 */
	export const focus = (): void => {
		textarea_el?.focus();
	};
</script>

<svelte:document
	onkeydown={onsave
		? (event) => {
				// Check for Ctrl+S or Command+S (Mac)
				if ((event.ctrlKey || event.metaKey) && event.key === 's') {
					swallow(event);
					onsave(content);
				}
			}
		: undefined}
/>

<div class="column width:100% flex:1">
	<div class="display:flex flex:1 gap_xs2 width:100%">
		<textarea
			{...attrs}
			class="plain mb_0 width:100% flex:1 {attrs?.class}"
			bind:this={textarea_el}
			bind:value={content}
			{placeholder}
			{readonly}
			style="{textarea_height ? `height: ${textarea_height};` : ''} {attrs?.style || ''}"
			{@attach focus_key == null
				? null
				: () => {
						if (focus_key === pending_element_to_focus_key) {
							pending_element_to_focus_key = null;
							focus();
						}
					}}
		></textarea>
		{@render children?.()}
	</div>

	{#if show_stats}
		<ContentStats {token_count} />
	{/if}

	{@render after?.()}

	{#if show_actions && !readonly}
		<div class="display:flex mt_xs">
			<CopyToClipboard text={content} class="plain" />
			<PasteFromClipboard
				onclipboardtext={(value) => {
					const new_content = content + value;
					content = new_content;
					focus();
				}}
				class="plain icon_button font_size_lg"
			>
				<!-- TODO should be default -->
				<Glyph glyph={GLYPH_PASTE} />
			</PasteFromClipboard>
			<ClearRestoreButton
				bind:value={
					() => content,
					(value) => {
						content = value;
						focus();
					}
				}
			/>
		</div>
	{/if}
</div>
