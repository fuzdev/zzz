<script lang="ts">
	import type {Snippet} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	let {
		active = $bindable(),
		active_content,
		inactive_content,
		...rest
	}: SvelteHTMLElements['button'] & {
		/**
		 * Current state of the toggle
		 */
		active: boolean;
		/**
		 * Content to display when toggle is active
		 */
		active_content: Snippet | string;
		/**
		 * Content to display when toggle is inactive
		 */
		inactive_content: Snippet | string;
	} = $props();
</script>

<button type="button" class="plain icon_button" {...rest} onclick={() => (active = !active)}>
	{@render rest.children?.()}
	<span class="position:relative">
		<span style:visibility="hidden" class="display:inline-flex flex-direction:column height:0">
			<span>
				{#if typeof active_content === 'string'}{active_content}{:else}{@render active_content()}{/if}
			</span>
			<span>
				{#if typeof inactive_content === 'string'}{inactive_content}{:else}{@render inactive_content()}{/if}
			</span>
		</span>
		<span class="position:absolute display:inline-flex align-items:center" style:inset="0">
			{#if active}
				{#if typeof active_content === 'string'}{active_content}{:else}{@render active_content()}{/if}
			{:else if typeof inactive_content === 'string'}
				{inactive_content}
			{:else}
				{@render inactive_content()}
			{/if}
		</span>
	</span>
</button>
