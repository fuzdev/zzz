<script lang="ts">
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import {GLYPH_ADD, GLYPH_SPACE} from './glyphs.js';
	import {SCRATCHPAD_NAME} from './spaces.svelte.js';

	const app = frontend_context.get();
</script>

{#if app.ui.show_desk_menu}
	<Dialog onclose={() => app.ui.toggle_desk_menu(false)} layout="page">
		<div class="box">
			<div class="pane p_xl3">
				<section class="box mb_xl3">
					<h2 class="mt_0">
						<Glyph glyph={GLYPH_SPACE} /> spaces
					</h2>
					<ul class="unstyled">
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
											<code class="flex:1 font_size_sm text-align:left">{dir_path}</code>
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
		</div>
	</Dialog>
{/if}
