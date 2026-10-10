<script lang="ts">
	import type { MarkdownLink } from './markdown_links.ts';

	/**
	 * A markdown document's broken links — relative paths the file index says
	 * are missing — each a button.
	 *
	 * @module
	 */

	const {
		links,
		onselect
	}: {
		/** The document's links, from `to_markdown_links`; only the broken ones are listed. */
		links: ReadonlyArray<MarkdownLink>;
		/** Called with the link's position in `links` when it's clicked. */
		onselect: (index: number, link: MarkdownLink) => void;
	} = $props();

	const broken = $derived(
		links.flatMap((link, index) => (link.status === 'broken' ? [{ link, index }] : []))
	);
</script>

<section>
	<h4 class="mb_xs">
		broken links{#if broken.length}&nbsp;<small class="negative_50">{broken.length}</small>{/if}
	</h4>
	{#if broken.length === 0}
		<p class="text_50 mb_0"><small>none found</small></p>
	{:else}
		<menu class="unstyled">
			{#each broken as { link, index } (index)}
				<button
					type="button"
					class="broken-link plain listitem sized_sm"
					title={link.target.kind === 'path' ? `not found: ${link.target.path}` : undefined}
					onclick={() => onselect(index, link)}
				>
					<span class="ellipsis">{link.text || link.reference}</span>
					{#if link.text && link.text !== link.reference}
						<small class="ellipsis font_family_mono text_50">{link.reference}</small>
					{/if}
				</button>
			{/each}
		</menu>
	{/if}
</section>

<style>
	.broken-link {
		flex-direction: column;
		align-items: flex-start;
	}
</style>
