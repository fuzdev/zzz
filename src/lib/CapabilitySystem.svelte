<script lang="ts">
	import { DEV } from 'esm-env';
	import { resolve } from '$app/paths';
	import { format_url } from '@fuzdev/fuz_util/url.ts';

	import { library_context } from './library.ts';
	import ExternalLink from './ExternalLink.svelte';

	const library = library_context.get();
</script>

<div>
	<p class="font_family_mono">{library.name}@{library.pkg_json.version}</p>
	<p class="font_family_mono">
		DEV: {DEV + ''}
	</p>
	<p><ExternalLink href={library.repo_url}>{format_url(library.repo_url)}</ExternalLink></p>
	<p><a href={resolve('/about')}>/about</a></p>
	<p><a href={resolve('/settings')}>/settings</a></p>
</div>
