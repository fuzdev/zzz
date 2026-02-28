<script module lang="ts">
	export const DESK_WIDTH = 260;
</script>

<script lang="ts">
	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import {GLYPH_ADD, GLYPH_PIN, GLYPH_SPACE} from './glyphs.js';
	import {SCRATCHPAD_NAME} from './spaces.svelte.js';
	import {click_outside} from './click_outside.svelte.js';

	const app = frontend_context.get();
</script>

{#if app.ui.show_desk_menu}
	<aside
		class="desk_sidebar"
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
						<li>
							<button
								type="button"
								class="width:100% gap_sm"
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
						</li>
					{/each}
				</ul>
				<button
					type="button"
					class="plain"
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
				<section class="box">
					<h3 class="mt_0 mb_md">
						{app.spaces.active.name === SCRATCHPAD_NAME ? 'scratchpad' : app.spaces.active.name} directories
					</h3>
					{#if app.scoped_dirs.length}
						<ul class="unstyled">
							{#each app.scoped_dirs as dir_path (dir_path)}
								{@const included = app.spaces.active.directory_paths.includes(dir_path)}
								<li>
									<button
										type="button"
										class="width:100% gap_sm"
										class:selected={included}
										onclick={() => {
											if (included) {
												app.spaces.active!.remove_directory(dir_path);
											} else {
												app.spaces.active!.add_directory(dir_path);
											}
										}}
									>
										<span class="flex:1 font_size_sm text-align:left font_family_mono"
											>{dir_path}</span
										>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text_50">no directories available</p>
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
