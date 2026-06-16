<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {SvgData} from '@fuzdev/fuz_ui/svg.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {icon_clear, icon_restore} from '@fuzdev/fuz_ui/icons.ts';

	import ToggleButton from './ToggleButton.svelte';

	let {
		value = $bindable(),
		onchange,
		restore_icon = icon_restore,
		clear_icon = icon_clear,
		...rest
	}: SvelteHTMLElements['button'] & {
		value: string;
		restore_icon?: Snippet | string | SvgData | undefined;
		clear_icon?: Snippet | string | SvgData | undefined;
	} = $props();

	let cleared_value = $state.raw('');

	const has_value = $derived(!!value);

	const disabled = $derived(!value && !cleared_value);
	const title = $derived(has_value ? 'clear' : 'restore');
</script>

<ToggleButton
	bind:active={
		() => has_value,
		(active) => {
			if (active) {
				// Restoring
				const restored = cleared_value;
				cleared_value = '';
				value = restored;
			} else {
				// Clearing
				cleared_value = value;
				value = '';
			}
		}
	}
	active_content={clear_content}
	inactive_content={restore_content}
	{...rest}
	{disabled}
	{title}
/>

{#snippet render_icon(value: Snippet | string | SvgData)}
	{#if typeof value === 'string'}{value}{:else if typeof value === 'function'}{@render value()}{:else}<Svg
			data={value}
		/>{/if}
{/snippet}
{#snippet clear_content()}{@render render_icon(clear_icon)}{/snippet}
{#snippet restore_content()}{@render render_icon(restore_icon)}{/snippet}
