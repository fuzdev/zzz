<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {Snippet} from 'svelte';
	import {scale} from 'svelte/transition';
	import {DEV} from 'esm-env';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import {Popover} from './popover.svelte.js';
	import type {Position, Alignment} from './position_helpers.js';

	const {
		position = 'bottom',
		align = 'center',
		disable_outside_click = false,
		popover_class,
		popover_attrs,
		popover_content,
		popover_container_attrs,
		button,
		children,
		...rest
	}: OmitStrict<SvelteHTMLElements['button'], 'children'> & {
		position?: Position | undefined;
		align?: Alignment | undefined;
		disable_outside_click?: boolean | undefined;
		popover_class?: string | undefined;
		popover_attrs?: SvelteHTMLElements['div'] | undefined;
		popover_content: Snippet<[popover: Popover]>;
		popover_container_attrs?: SvelteHTMLElements['div'] | undefined;
		button?: Snippet<[popover: Popover]> | undefined;
		children?: Snippet<[popover: Popover]> | undefined;
	} = $props();

	// TODO @many type union instead of this pattern?
	if (DEV) {
		if (children && button) {
			console.error('PopoverButton has both children and button defined - button takes precedence');
		}
		if (!children && !button) {
			console.error('PopoverButton requires either children or a button snippet prop');
		}
	}

	// Create a popover instance
	const popover = new Popover();

	// TODO refactor, try to remove
	// This hides the popover when the button is disabled
	$effect.pre(() => {
		if (rest.disabled) {
			popover.hide();
		}
	});
</script>

<!-- TODO these flex values fix some layout cases so that the container is laid out like the button, but this is a partial solution -->
<div
	{...popover_container_attrs}
	class="position:relative {popover_container_attrs?.class}"
	{@attach popover.container}
>
	{#if button}
		{@render button(popover)}
	{:else}
		<button
			type="button"
			class="icon_button"
			{@attach popover.trigger({
				position,
				align,
				disable_outside_click,
			})}
			{...rest}
		>
			{@render children?.(popover)}
		</button>
	{/if}

	{#if popover.visible}
		<div
			{@attach popover.content({
				position,
				align,
				disable_outside_click,
				popover_class,
			})}
			in:scale={{duration: 80}}
			out:scale={{duration: 200}}
			{...popover_attrs}
		>
			{@render popover_content(popover)}
		</div>
	{/if}
</div>
