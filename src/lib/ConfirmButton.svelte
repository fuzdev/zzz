<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {ComponentProps, Snippet} from 'svelte';
	import {DEV} from 'esm-env';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import PopoverButton from './PopoverButton.svelte';
	import {GLYPH_REMOVE} from './glyphs.js';
	import type {Popover} from './popover.svelte.js';
	import Glyph from './Glyph.svelte';

	const {
		onconfirm,
		popover_button_attrs,
		hide_on_confirm = true,
		position = 'left',
		popover_content: popover_content_prop,
		popover_button_content,
		button,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof PopoverButton>, 'popover_content' | 'children'> &
		OmitStrict<SvelteHTMLElements['button'], 'children'> & {
			onconfirm: (popover: Popover) => void;
			popover_button_attrs?: SvelteHTMLElements['button'] | undefined;
			hide_on_confirm?: boolean | undefined;
			/** Unlike on `PopoverButton` this is optional and has a `confirm` arg */
			popover_content?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
			/** Content for the popover button */
			popover_button_content?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
			/** Unlike on `PopoverButton` this has a `confirm` arg */
			children?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
		} = $props();

	// TODO @many type union instead of this pattern?
	if (DEV) {
		if (popover_content_prop && popover_button_attrs) {
			console.error(
				'ConfirmButton has both popover_content and popover_attrs defined - popover_content takes precedence',
			);
		}
		if (popover_content_prop && popover_button_content) {
			console.error(
				'ConfirmButton has both popover_content and popover_button_content defined - popover_content takes precedence',
			);
		}
	}

	const confirm = (popover: Popover): void => {
		if (hide_on_confirm) popover.hide();
		onconfirm(popover);
	};
</script>

<PopoverButton {position} {button} {...rest} children={button ? undefined : children_default}>
	{#snippet popover_content(popover)}
		{#if popover_content_prop}
			{@render popover_content_prop(popover, () => confirm(popover))}
		{:else}
			<button
				type="button"
				class="icon_button color_c"
				onclick={() => confirm(popover)}
				title="confirm {rest.title || ''}"
				{...popover_button_attrs}
			>
				{#if popover_button_content}
					{@render popover_button_content(popover, () => confirm(popover))}
				{:else}
					<Glyph glyph={GLYPH_REMOVE} />
				{/if}
			</button>
		{/if}
	{/snippet}
</PopoverButton>

{#snippet children_default(popover: Popover)}
	{#if children}
		{@render children(popover, () => confirm(popover))}
	{:else}
		<Glyph glyph={GLYPH_REMOVE} />
	{/if}
{/snippet}

<style>
	/* TODO these are a hack, fix after changing fuz_css to opaque bg colors (and use color_c_2 or something) */
	button {
		background-color: #fff;
	}
	:global(.dark) button {
		background-color: #000;
	}
</style>
