<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	import type { BrowserTab } from './browser_tab.svelte.ts';
	import { to_browser_tab_iframe_src } from './browser_helpers.ts';

	const {
		tab,
		children
	}: {
		tab: BrowserTab;
		children: Snippet;
	} = $props();

	// Function to extract title from iframe content
	// TODO both iframes are sandboxed without `allow-same-origin`, so they're
	// opaque-origin and `contentDocument` is always null — find another way to get titles
	function handle_iframe_load(event: Event): void {
		const iframe = event.target as HTMLIFrameElement;
		try {
			// Only works for same-origin content due to CORS
			const title = iframe.contentDocument?.title;
			if (title?.trim() && title !== tab.title) {
				tab.title = title.trim();
			}
		} catch (error) {
			// Will fail for cross-origin content
			console.log('Unable to access iframe content:', error);
		}
	}

	// untrusted pages load in an opaque origin (no `allow-same-origin`), and
	// URLs that could reach the app are refused outright
	const iframe_src = $derived(
		tab.type === 'external_url' ? to_browser_tab_iframe_src(tab.url, page.url.origin) : null
	);

	// Wrap HTML content with proper background styling
	const wrapped_content = $derived(
		tab.type === 'embedded_html' && tab.content
			? `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<style>
		:root {
			color-scheme: light dark;
		}
		body {
			background: light-dark(white, #1a1a1a);
			color: light-dark(#000, #fff);
			margin: 0;
		}
	</style>
</head>
<body>
${tab.content}
</body>
</html>`
			: tab.content
	);
</script>

{#key tab.refresh_counter}
	{#if tab.type === 'embedded_html'}
		<div class="iframe-container">
			<!-- Using srcdoc to render the HTML content -->
			<iframe
				title={tab.title}
				srcdoc={wrapped_content}
				sandbox="allow-scripts allow-popups"
				onload={handle_iframe_load}
			></iframe>
		</div>
	{:else if tab.type === 'external_url'}
		{#if iframe_src}
			<div class="iframe-container">
				<iframe
					title={tab.title}
					src={iframe_src}
					sandbox="allow-scripts"
					onload={handle_iframe_load}
				></iframe>
			</div>
		{:else}
			<div class="p_lg">
				<p>
					can't open <code class="overflow-wrap:anywhere">{tab.url}</code> — tabs load only
					<code>http</code> and <code>https</code> URLs from other sites
				</p>
			</div>
		{/if}
	{:else}
		<!-- Raw tab content -->
		<div class="p_lg">
			{@render children()}
		</div>
	{/if}
{/key}

<style>
	.iframe-container {
		display: flex; /* fixes a height bug */
		width: 100%;
		height: 100%;
	}

	iframe {
		width: 100%;
		height: 100%;
		border: none;
		background: light-dark(white, #1a1a1a);
	}
</style>
