<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import {GLYPH_CLEAR, GLYPH_RESTORE} from './glyphs.js';
	import ToggleButton from './ToggleButton.svelte';

	let {
		value,
		onchange,
		restore_icon = GLYPH_RESTORE,
		clear_icon = GLYPH_CLEAR,
		...rest
	}: SvelteHTMLElements['button'] & {
		value: string;
		restore_icon?: Snippet | string | undefined;
		clear_icon?: Snippet | string | undefined;
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
	active_content={clear_icon}
	inactive_content={restore_icon}
	{...rest}
	{disabled}
	{title}
/>
