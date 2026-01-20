<script lang="ts">
	import {resolve} from '$app/paths';

	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import PromptList from './PromptList.svelte';
	import ChatList from './ChatList.svelte';
	import ModelLink from './ModelLink.svelte';
	import {GLYPH_ADD, GLYPH_PROVIDER, GLYPH_MODEL} from './glyphs.js';
	import {to_nav_link_href} from './nav.js';

	const app = frontend_context.get();
</script>

<div class="p_lg">
	<section class="display:flex flex-wrap:wrap align-items:start gap_lg">
		<div class="panel p_md flex:1 width_atleast_sm" style:max-width="480px">
			<h3 class="mt_0 mb_lg display:flex align-items:center justify-content:space-between">
				<a
					class="font-weight:500 text_color_2"
					href={/* eslint-disable-line svelte/no-navigation-without-resolve */ to_nav_link_href(
						app,
						'chats',
						resolve('/chats'),
					)}>chats</a
				>
				<button
					type="button"
					class="plain icon_button font_size_md"
					title="create new chat"
					onclick={() => {
						const chat = app.chats.add();
						void app.chats.navigate_to(chat.id);
					}}
				>
					<Glyph glyph={GLYPH_ADD} />
				</button>
			</h3>
			{#if app.chats.ordered_items.length}
				<ChatList />
			{:else}
				<div class="text-align:center p_md">
					<button
						type="button"
						class="color_d"
						onclick={() => {
							const chat = app.chats.add();
							void app.chats.navigate_to(chat.id);
						}}
					>
						create your first chat
					</button>
				</div>
			{/if}
		</div>
		<div class="panel p_md flex:1 width_atleast_sm" style:max-width="480px">
			<h3 class="mt_0 mb_lg display:flex align-items:center justify-content:space-between">
				<a
					class="font-weight:500 text_color_2"
					href={/* eslint-disable-line svelte/no-navigation-without-resolve */ to_nav_link_href(
						app,
						'prompts',
						resolve('/prompts'),
					)}>prompts</a
				>
				<button
					type="button"
					class="plain icon_button font_size_md"
					title="create new prompt"
					onclick={() => {
						const prompt = app.prompts.add();
						void app.prompts.navigate_to(prompt.id);
					}}
				>
					<Glyph glyph={GLYPH_ADD} />
				</button>
			</h3>
			{#if app.prompts.ordered_items.length}
				<PromptList />
			{:else}
				<div class="text-align:center p_md">
					<button
						type="button"
						onclick={() => {
							const prompt = app.prompts.add();
							void app.prompts.navigate_to(prompt.id);
						}}
					>
						create your first prompt
					</button>
				</div>
			{/if}
		</div>
		<div class="panel p_md flex:1 width_atleast_sm" style:max-width="480px">
			<div class="mb_lg">
				<a href={resolve('/providers')} class="text_color_2"
					><Glyph glyph={GLYPH_PROVIDER} />
					<h3 class="display:inline my_0">providers</h3></a
				>
			</div>
			<div>
				<ul class="unstyled">
					{#each app.providers.items as provider (provider.name)}
						<li>
							<ProviderLink
								{provider}
								icon="svg"
								class="menu_item row justify-content:start gap_xs py_xs"
							/>
						</li>
					{:else}
						<p>no providers configured yet</p>
					{/each}
				</ul>
			</div>
		</div>
		<div class="panel p_md flex:1 width_atleast_sm" style:max-width="480px">
			<div class="mb_lg">
				<a href={resolve('/models')} class="text_color_2"
					><Glyph glyph={GLYPH_MODEL} />
					<h3 class="display:inline my_0">models</h3></a
				>
			</div>
			<div>
				<ul class="unstyled">
					{#each app.models.ordered_by_name as model (model.name)}
						<li>
							<ModelLink {model} icon class="menu_item row justify-content:start gap_xs py_xs" />
						</li>
					{:else}
						<p>no models available yet</p>
					{/each}
				</ul>
			</div>
		</div>
	</section>
</div>
