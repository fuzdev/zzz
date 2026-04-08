<script module lang="ts">
	export const DESK_WIDTH = 260;
</script>

<script lang="ts">
	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import EditableText from './EditableText.svelte';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import {GLYPH_ADD, GLYPH_DELETE, GLYPH_PIN, GLYPH_SPACE} from './glyphs.js';
	import {SCRATCHPAD_NAME} from './spaces.svelte.js';
	import {click_outside} from './click_outside.svelte.js';

	const app = frontend_context.get();
</script>

{#if app.ui.show_desk_menu}
	<aside
		class="desk_sidebar unstyled p_md"
		{@attach app.ui.desk_pinned ? null : click_outside(() => app.ui.toggle_desk_menu(false))}
	>
		<div>
			<section class="box mb_xl3">
				<div class="width:100% row gap_sm mb_xl">
					<h2 class="mt_0 flex:1">
						<Glyph glyph={GLYPH_SPACE} /> spaces
					</h2>
					<button
						type="button"
						class="icon_button compact"
						class:selected={app.ui.desk_pinned}
						title={app.ui.desk_pinned ? 'unpin desk' : 'pin desk'}
						onclick={() => app.ui.toggle_desk_pinned()}
					>
						<Glyph glyph={GLYPH_PIN} />
					</button>
				</div>
				<ul class="unstyled width:100%">
					{#each app.spaces.items.values as space (space.id)}
						<li class="row gap_xs">
							<button
								type="button"
								class="flex:1 gap_sm"
								class:selected={space.id === app.spaces.active_id}
								onclick={() => {
									app.spaces.activate(space.id);
								}}
							>
								<span class="flex:1 text-align:left">{space.name}</span>
								<span class="text_50 font_size_sm">
									{space.directory_count}
									{space.directory_count === 1 ? 'dir' : 'dirs'}
								</span>
							</button>
							{#if space.name !== SCRATCHPAD_NAME}
								<ConfirmButton
									onconfirm={() => app.spaces.remove(space.id)}
									class="icon_button compact plain deselectable"
									title="delete space"
								>
									<Glyph glyph={GLYPH_DELETE} />
								</ConfirmButton>
							{/if}
						</li>
					{/each}
				</ul>
				<button
					type="button"
					class="plain width:100%"
					title="create new space"
					onclick={() => {
						const space = app.spaces.add();
						app.spaces.activate(space.id);
					}}
				>
					<Glyph glyph={GLYPH_ADD} /> new space
				</button>
			</section>

			{#if app.spaces.active}
				<section>
					<h3 class="mt_0 mb_md row gap_sm">
						<EditableText bind:value={app.spaces.active.name} />
						<span class="text_50 font_size_sm">directories</span>
					</h3>
					{#if app.workspaces.items.by_id.size > 0}
						<ul class="unstyled">
							{#each app.workspaces.items.values as workspace (workspace.id)}
								{@const included = app.spaces.active.directory_paths.includes(workspace.path)}
								<li>
									<button
										type="button"
										class="width:100% gap_sm"
										class:selected={included}
										onclick={async () => {
											if (included) {
												app.spaces.active!.remove_directory(workspace.path);
											} else {
												// ensure workspace is open on the backend before adding to space
												if (!app.workspaces.get_by_path(workspace.path)) {
													await app.api.workspace_open({path: workspace.path});
												}
												app.spaces.active!.add_directory(workspace.path);
											}
										}}
									>
										<span class="flex:1 font_size_sm text-align:left font_family_mono"
											>{workspace.path}</span
										>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text_50">no workspaces open</p>
					{/if}
				</section>
			{/if}
		</div>
	</aside>
{/if}

<style>
	.desk_sidebar {
		position: fixed;
		top: 0;
		right: 0;
		height: 100%;
		width: 260px;
		overflow: auto;
		scrollbar-width: thin;
		background: var(--shade_10);
		border-left: var(--border_width) solid var(--border_color);
		z-index: 1;
	}
</style>
