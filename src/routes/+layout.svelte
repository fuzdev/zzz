<script lang="ts">
	import '$routes/fuz.css';
	import '@fuzdev/fuz_code/theme.css';
	import '$routes/style.css';

	import {onMount} from 'svelte';
	import {contextmenu_attachment} from '@fuzdev/fuz_ui/contextmenu_state.svelte.js';
	import {Library} from '@fuzdev/fuz_ui/library.svelte.js';
	import {BROWSER} from 'esm-env';
	import {page} from '$app/state';
	import {onNavigate} from '$app/navigation';
	import {resolve} from '$app/paths';

	import {parse_url_param_uuid} from '$lib/url_params_helpers.js';
	import {App} from '$lib/app.svelte.js';
	import FrontendRoot from '$lib/FrontendRoot.svelte';
	import {library_context} from '$lib/library.js';
	import {library_json} from '$routes/library.js';
	import {ProviderJson} from '$lib/provider.svelte.js';
	import create_zzz_config from '$lib/config.js';
	import {ModelJson} from '$lib/model.svelte.js';
	import {DOCS_PATH} from '@fuzdev/fuz_ui/docs_helpers.svelte.js';

	const {children, params} = $props();

	// TODO think through initialization
	onMount(() => {
		// TODO init properly from data
		const zzz_config = create_zzz_config();

		// TODO note the difference between these two APIs, look at both of them and see which makes more sense
		app.add_providers(zzz_config.providers.map((p) => ProviderJson.parse(p))); // TODO handle errors
		app.models.add_many(zzz_config.models.map((m) => ModelJson.parse(m))); // TODO handle errors

		// init the session
		if (BROWSER) {
			void app.api.session_load();
		}

		// init Ollama
		if (BROWSER) {
			void app.ollama.refresh();
		}
	});

	// TODO should load granularly when needed (/docs, /about), but currently the capabilities page uses the package json data, how better to get that? generate a more minimal metadata file?
	library_context.set(new Library(library_json));

	// Create the frontend's App, which extends Frontend
	const app = new App();

	if (BROWSER) (window as any).app = (window as any).app = app; // no types for this, just for runtime convenience

	// TODO refactor, maybe per route?
	// Handle URL parameter synchronization
	$effect.pre(() => {
		// TODO I think we want a different state value for this, so that we can render links to the "selected_id_recent" or something
		app.chats.selected_id = parse_url_param_uuid(params.chat_id);
		app.prompts.selected_id = parse_url_param_uuid(params.prompt_id);
	});

	// TODO refactor this, doesn't belong here - see the comment at `to_nav_link_href`
	onNavigate(() => {
		const {pathname} = page.url;
		if (pathname === resolve('/chats')) {
			app.chats.selected_id_last_non_null = null;
		} else if (pathname === resolve('/prompts')) {
			app.prompts.selected_id_last_non_null = null;
		}
	});
</script>

<svelte:head>
	<title>Zzz</title>
</svelte:head>

<svelte:body
	{@attach contextmenu_attachment([
		{
			snippet: 'text',
			props: {
				content: 'settings',
				icon: '?',
				run: () => {
					console.log('show main dialog');
					app.api.toggle_main_menu({show: true});
				},
			},
		},
		{
			snippet: 'text',
			props: {
				content: 'reload',
				icon: '⟳',
				run: () => {
					location.reload();
				},
			},
		},
	])}
/>

<!-- TODO hacky, docs need to nest gracefully with abosolute positioning, or at least support offset vars -->
{#if page.url.pathname === DOCS_PATH || page.url.pathname.startsWith(DOCS_PATH + '/')}
	{@render children()}
{:else}
	<FrontendRoot {app}>
		{@render children()}
	</FrontendRoot>
{/if}
