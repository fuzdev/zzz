<script lang="ts">
	import type { MarkdownHeading } from './markdown_links.ts';

	/**
	 * A markdown document's outline: its headings, indented by level, each a
	 * button.
	 *
	 * @module
	 */

	const {
		headings,
		onselect
	}: {
		/** The document's headings, from `to_markdown_headings`. */
		headings: ReadonlyArray<MarkdownHeading>;
		/** Called with the heading's position in `headings` when it's clicked. */
		onselect: (index: number, heading: MarkdownHeading) => void;
	} = $props();

	// indent relative to the shallowest level, so a document without an `h1` isn't all indented
	const min_level = $derived(headings.reduce((min, h) => Math.min(min, h.level), 6));
</script>

<section>
	<h4 class="mb_xs">outline</h4>
	{#if headings.length === 0}
		<p class="text_50 mb_0"><small>no headings</small></p>
	{:else}
		<menu class="unstyled">
			{#each headings as heading, i (i)}
				<button
					type="button"
					class="outline-item plain listitem sized_sm"
					style:--outline_depth={heading.level - min_level}
					title={heading.id ? `#${heading.id}` : undefined}
					onclick={() => onselect(i, heading)}
				>
					<span class="ellipsis">{heading.text || '(untitled)'}</span>
				</button>
			{/each}
		</menu>
	{/if}
</section>

<style>
	.outline-item {
		justify-content: flex-start;
		padding-left: calc(var(--space_sm) + var(--outline_depth, 0) * var(--space_md));
	}
</style>
