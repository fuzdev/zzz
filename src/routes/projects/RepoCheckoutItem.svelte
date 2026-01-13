<script lang="ts">
	// @slop Claude Opus 4

	import {GLYPH_DELETE} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import type {RepoCheckout} from '$routes/projects/projects_schema.js';

	const {
		checkout,
		index,
		on_remove,
		on_add_tag,
		on_remove_tag,
	}: {
		checkout: RepoCheckout;
		index: number;
		on_remove: (index: number) => void;
		on_add_tag: (index: number, tag: string) => void;
		on_remove_tag: (index: number, tag_index: number) => void;
	} = $props();

	let tag_input = $state('');
	let tag_el: HTMLInputElement | undefined = $state();
</script>

<div class="panel p_sm mb_md">
	<div class="mb_sm">
		<label>
			<span class="display:block mb_xs">Path</span>
			<input
				type="text"
				bind:value={checkout.path}
				class="width:100%"
				placeholder="./path/to/repo/checkout"
			/>
		</label>
	</div>

	<div class="mb_sm">
		<label>
			<span class="display:block mb_xs">Label</span>
			<input
				type="text"
				bind:value={checkout.label}
				class="width:100%"
				placeholder="description (e.g. 'development', 'some-feature-branch', 'some-bug-repro')"
			/>
		</label>
	</div>

	<div class="mb_sm">
		<span class="display:block mb_xs">Tags</span>
		<div class="display:flex flex-wrap:wrap gap_xs mb_xs">
			{#each checkout.tags as tag, tag_index (tag_index)}
				<span class="chip color_e display:flex align-items:center">
					{tag}
					<button
						type="button"
						class="icon_button plain font_size_xs ml_xs"
						title="Remove tag"
						onclick={() => on_remove_tag(index, tag_index)}><Glyph glyph={GLYPH_DELETE} /></button
					>
				</span>
			{/each}
		</div>
		<div class="display:flex gap_xs">
			<input
				type="text"
				bind:value={tag_input}
				bind:this={tag_el}
				placeholder="new tag"
				class="flex:1"
			/>
			<button
				type="button"
				onclick={() => {
					if (!tag_input) {
						tag_el?.focus();
						return;
					}
					on_add_tag(index, tag_input);
					tag_input = '';
				}}
			>
				add tag
			</button>
		</div>
	</div>

	<div class="display:flex justify-content:end">
		<button type="button" class="color_c" onclick={() => on_remove(index)}>
			<Glyph glyph={GLYPH_DELETE} />&nbsp; delete checkout
		</button>
	</div>
</div>

<style>
	.chip {
		padding: 3px 8px;
		border-radius: 12px;
		font-size: 0.85em;
	}
</style>
