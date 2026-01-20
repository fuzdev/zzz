<script lang="ts">
	import ConfirmButton from './ConfirmButton.svelte';
	import {Chat} from './chat.svelte.js';

	const {
		chat,
	}: {
		chat: Chat;
	} = $props();

	const {app} = $derived(chat);

	const tags = $derived(Array.from(app.tags)); // TODO refactor, `Tags` may be a class, maybe with an indexed collection
</script>

<div>
	<!-- TODO add user-customizable sets of models -->
	<div class="display:flex">
		<div class="flex:1 p_xs">
			<header class="font_size_lg text-align:center mb_xs">add by tag</header>
			<menu class="unstyled column">
				{#each tags as tag (tag)}
					{@const models_with_tag = app.models.filter_by_tag(tag)}
					<button
						type="button"
						class="width:100% font_size_sm py_xs3 justify-content:space-between plain border_radius_xs font-weight:600"
						style:min-height="0"
						onclick={() => {
							chat.add_threads_by_model_tag(tag);
						}}
					>
						<span>{tag}</span>
						{#if models_with_tag.length}
							<span>{models_with_tag.length}</span>
						{/if}
					</button>
				{/each}
			</menu>
		</div>
		<div class="flex:1 p_xs fg_1">
			<header class="font_size_lg text-align:center mb_xs">remove by tag</header>
			<menu class="unstyled column">
				{#each tags as tag (tag)}
					<!-- TODO index this -->
					{@const threads_with_tag = chat.threads.filter((t) => t.model.tags.includes(tag))}
					<ConfirmButton
						disabled={!threads_with_tag.length}
						class="width:100% font_size_sm py_xs3 justify-content:space-between plain border_radius_xs font-weight:600"
						style="min-height: 0;"
						onconfirm={() => {
							chat.remove_threads_by_model_tag(tag);
						}}
					>
						<span>{tag}</span>
						{#if threads_with_tag.length}
							<span>{threads_with_tag.length}</span>
						{/if}
					</ConfirmButton>
				{/each}
			</menu>
		</div>
		<!-- TODO add custom buttons -->
	</div>
</div>
