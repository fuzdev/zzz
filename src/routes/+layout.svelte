<script lang="ts">
	import 'virtual:fuz.css';
	import '@fuzdev/fuz_code/theme.css';
	import './style.css';

	import { untrack } from 'svelte';
	import { contextmenu_attachment } from '@fuzdev/fuz_ui/contextmenu_state.svelte.ts';
	import { icon_refresh, icon_settings } from '@fuzdev/fuz_ui/icons.ts';
	import { Library } from '@fuzdev/fuz_ui/library.svelte.ts';
	import { BROWSER } from 'esm-env';
	import { page } from '$app/state';
	import { onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { AuthState, auth_state_context } from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';
	import LoginForm from '@fuzdev/fuz_app/ui/LoginForm.svelte';
	import BootstrapForm from '@fuzdev/fuz_app/ui/BootstrapForm.svelte';
	import Alert from '@fuzdev/fuz_ui/Alert.svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import { parse_url_param_uuid } from '$lib/url_params_helpers.ts';
	import { App } from '$lib/app.svelte.ts';
	import FrontendRoot from '$lib/FrontendRoot.svelte';
	import { library_context } from '$lib/library.ts';
	import { SiteState, site_context } from '@fuzdev/fuz_ui/site.svelte.ts';
	import { logo_zzz } from '$lib/logos.ts';
	import { library_json_from_modules } from '@fuzdev/fuz_util/library_json.ts';
	import { modules } from 'virtual:svelte-docinfo';
	import pkg_json from 'virtual:pkg.json';
	import { ProviderJson } from '$lib/provider.svelte.ts';
	import create_zzz_config from '$lib/config.ts';
	import { ModelJson } from '$lib/model.svelte.ts';
	import { DOCS_PATH } from '@fuzdev/fuz_ui/docs_helpers.svelte.ts';

	const { children, params } = $props();

	const library_json = library_json_from_modules(pkg_json, modules);

	// Auth state — gate all content behind authentication
	const auth_state = auth_state_context.set(new AuthState());
	void auth_state.check_session();

	// Gate liveness probe — `check_session` can't distinguish a downed daemon
	// from a logged-out 401, so probe `/health` to show a recovery hint instead
	// of a dead login form. Browser-only.
	let probing = $state.raw(true);
	let backend_unreachable = $state.raw(false);
	if (BROWSER) {
		void (async () => {
			try {
				const response = await fetch('/health');
				backend_unreachable = !response.ok;
			} catch {
				backend_unreachable = true;
			} finally {
				probing = false;
			}
		})();
	}

	// TODO should load granularly when needed (/docs, /about), but currently the capabilities page uses the package json data, how better to get that? generate a more minimal metadata file?
	library_context.set(new Library(library_json));
	site_context.set(new SiteState({ icon: logo_zzz, pkg_json }));

	// Create the frontend's App only after auth is verified
	let app: App | undefined = $state.raw();

	// TODO init properly from data
	const init_app = (): void => {
		const zzz_config = create_zzz_config();
		const new_app = new App();
		new_app.add_providers(zzz_config.providers.map((p) => ProviderJson.parse(p))); // TODO handle errors
		new_app.models.add_many(zzz_config.models.map((m) => ModelJson.parse(m))); // TODO handle errors

		app = new_app;

		if (BROWSER) {
			(window as any).app = new_app; // no types for this, just for runtime convenience
			void new_app.api.session_load();
		}
	};

	$effect.pre(() => {
		if (!auth_state.verified || app) return;
		untrack(init_app);
	});

	// TODO refactor, maybe per route?
	// Handle URL parameter synchronization
	$effect.pre(() => {
		if (!app) return;
		// TODO I think we want a different state value for this, so that we can render links to the "selected_id_recent" or something
		app.chats.selected_id = parse_url_param_uuid(params.chat_id);
		app.prompts.selected_id = parse_url_param_uuid(params.prompt_id);
	});

	// TODO refactor this, doesn't belong here - see the comment at `to_nav_link_href`
	onNavigate(() => {
		if (!app) return;
		const { pathname } = page.url;
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
				icon: icon_settings,
				run: () => {
					app?.api.toggle_main_menu({ show: true });
				}
			}
		},
		{
			snippet: 'text',
			props: {
				content: 'reload',
				icon: icon_refresh,
				run: () => {
					location.reload();
				}
			}
		}
	])}
/>

{#if auth_state.verified && app}
	<!-- TODO hacky, docs need to nest gracefully with abosolute positioning, or at least support offset vars -->
	{#if page.url.pathname === DOCS_PATH || page.url.pathname.startsWith(DOCS_PATH + '/')}
		{@render children()}
	{:else}
		<FrontendRoot {app}>
			{@render children()}
		</FrontendRoot>
	{/if}
{:else}
	<div class="gate">
		{#if auth_state.verifying || probing}
			<p class="text_50">verifying session...</p>
		{:else if backend_unreachable}
			<div class="width_atmost_sm">
				<Alert status="error">
					<p class="mt_0 mb_sm"><strong>The zzz backend isn't responding.</strong></p>
					<p class="mb_sm">Start it, then reload:</p>
					<p class="row gap_sm mb_0">
						<code>cargo xtask dev</code>
						<CopyToClipboard text="cargo xtask dev" />
					</p>
				</Alert>
			</div>
		{:else if auth_state.needs_bootstrap}
			<h1>zzz</h1>
			<p>No accounts exist yet. Create the first admin account.</p>
			<p>
				Get the bootstrap token: <code>cat .zzz/bootstrap_token</code>
				<CopyToClipboard text="cat .zzz/bootstrap_token" />
			</p>
			<BootstrapForm />
		{:else}
			<h1>zzz</h1>
			<div class="width_atmost_sm">
				<LoginForm />
			</div>
		{/if}
	</div>
{/if}

<style>
	.gate {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0 auto;
		padding: var(--space_xl5) var(--space_lg);
	}
</style>
