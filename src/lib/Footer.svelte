<script lang="ts">
	import Breadcrumb from '@fuzdev/fuz_ui/Breadcrumb.svelte';
	import DocsFooter from '@fuzdev/fuz_ui/DocsFooter.svelte';
	import {site_context} from '@fuzdev/fuz_ui/site.svelte.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {page} from '$app/state';
	import {resolve} from '$app/paths';

	import {logo_zzz} from './logos.ts';

	const site = site_context.get();
</script>

<DocsFooter repo_url={site.repo_url}>
	<div class="mb_xl5">
		{#if page.url.pathname === resolve('/')}
			<a href={resolve('/about')}>{@render icon()}</a>
		{:else}
			<Breadcrumb />
		{/if}
	</div>
</DocsFooter>

{#snippet icon()}<Svg data={logo_zzz} size="var(--icon_size_sm)" />{/snippet}
