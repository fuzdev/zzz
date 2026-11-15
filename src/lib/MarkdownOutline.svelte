<script lang="ts">
	import type { MarkdownHeading } from './markdown_links.ts';

	/**
	 * A markdown document's outline: its headings, indented by level, each a
	 * button. Like a docs page's links, it can light what the reader sees: the
	 * sections on screen dimly (`onscreen`), the one the reader is at brighter
	 * (`current`, also `aria-current`).
	 *
	 * @module
	 */

	const {
		headings,
		onscreen,
		current = null,
		onselect
	}: {
		/** The document's headings, from `to_markdown_headings`. */
		headings: ReadonlyArray<MarkdownHeading>;
		/** The positions in `headings` of the sections on screen, from `to_onscreen_sections`. */
		onscreen?: ReadonlySet<number> | undefined;
		/** The position in `headings` of the section the reader is at, `null` for none. */
		current?: number | null | undefined;
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
					class={[
						'outline-item plain listitem sized_sm',
						{ highlighted: onscreen?.has(i), current: i === current }
					]}
					style:--outline_depth={heading.level - min_level}
					title={heading.id ? `#${heading.id}` : undefined}
					aria-current={i === current ? 'location' : undefined}
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
	/* as a docs page's links light up: on screen or hovered dimly, current or pressed brighter */
	.outline-item:is(.highlighted, :hover) {
		--button_fill: var(--ink_10);
	}
	.outline-item:is(.current, :active) {
		--button_fill: var(--ink_20);
	}
</style>
