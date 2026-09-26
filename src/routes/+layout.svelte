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
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

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
	import { create_session_recheck } from '$lib/session_recheck.ts';
	import {
		backend_reachable_context,
		is_public_route,
		PUBLIC_ROUTE_PATHS,
		probe_backend,
		to_auth_gate_state,
		to_auth_redirect
	} from '$lib/auth_gate.ts';
	import { create_detached } from '$lib/reactive_helpers.svelte.ts';

	const { children, params } = $props();

	const library_json = library_json_from_modules(pkg_json, modules);

	// Auth state — gates every route but the public ones (about, docs) behind
	// a session. Only the first check shows the gate's spinner: a later one
	// (a login or bootstrap in flight, a recheck) keeps the form mounted.
	const auth_state = auth_state_context.set(new AuthState());
	let session_checked = $state.raw(false);
	if (BROWSER) {
		void auth_state.check_session().finally(() => {
			session_checked = true;
		});
	}

	// Gate liveness probe — `check_session` can't distinguish a missing daemon
	// (a static build served on its own, or a stopped daemon) from a
	// logged-out 401, so probe the backend to say the daemon is needed instead
	// of showing a dead login form. Browser-only.
	let backend_checked = $state.raw(false);
	let backend_reachable = $state.raw(false);
	if (BROWSER) {
		void probe_backend().then((reachable) => {
			backend_reachable = reachable;
			backend_checked = true;
		});
	}

	const public_route = $derived(
		is_public_route(
			page.url.pathname,
			PUBLIC_ROUTE_PATHS.map((path) => resolve(path))
		)
	);
	const gate_state = $derived(
		to_auth_gate_state({
			session_checked,
			backend_checked,
			backend_reachable,
			verified: auth_state.verified,
			needs_bootstrap: auth_state.needs_bootstrap
		})
	);
	// a login or bootstrap returns to the page it replaced, deep link intact
	const auth_redirect = $derived(to_auth_redirect(page.url, resolve('/')));
	// public routes read this to say what they're missing (the daemon, or a login)
	backend_reachable_context.set(() => (backend_checked ? backend_reachable : null));

	// TODO should load granularly when needed (/docs, /about), but currently the capabilities page uses the package json data, how better to get that? generate a more minimal metadata file?
	library_context.set(new Library(library_json));
	site_context.set(new SiteState({ icon: logo_zzz, pkg_json }));

	// Re-verify the session when the backend hints it's gone; `check_session`
	// flips `verified` off, which tears the App down and shows the login gate.
	// Only a definitive 401 counts, so a daemon restart doesn't log anyone out.
	// A session still valid after a revoked socket means a revocation ended
	// another session (another tab's logout, a token revoke-all) but closed
	// every socket of the account — so reconnect.
	const recheck_session = create_session_recheck({
		on_invalid: () => auth_state.check_session(),
		on_valid: () => {
			app?.socket.reconnect_revoked();
		}
	});

	// Create the frontend's App only after auth is verified
	let app: App | undefined = $state.raw();

	// TODO init properly from data
	const init_app = (): void => {
		const zzz_config = create_zzz_config();
		// detached from the effect that runs this — the app outlives it (see `create_detached`)
		const new_app = create_detached(() => {
			const created = new App({ on_unauthenticated: () => void recheck_session() });
			created.add_providers(zzz_config.providers.map((p) => ProviderJson.parse(p))); // TODO handle errors
			created.models.add_many(zzz_config.models.map((m) => ModelJson.parse(m))); // TODO handle errors
			return created;
		});

		app = new_app;

		if (BROWSER) {
			(window as any).app = new_app; // no types for this, just for runtime convenience
			new_app.boot_session();
		}
	};

	$effect.pre(() => {
		if (!auth_state.verified || app) return;
		untrack(init_app);
	});

	// Session gone (logout, or a recheck found it revoked/expired) — drop the
	// App so its socket stops reconnecting and a fresh one starts after login.
	$effect.pre(() => {
		if (auth_state.verified || !app) return;
		const old_app = app;
		app = undefined;
		untrack(() => old_app.dispose());
		if (BROWSER && (window as any).app === old_app) (window as any).app = undefined;
	});

	// The server closed the socket as revoked, or reconnects keep failing (a
	// browser can't tell an expired session's 401 upgrade from a downed daemon).
	$effect(() => {
		if (!app) return;
		if (app.socket.revoked || app.socket.reconnect_count >= 2) {
			void recheck_session();
		}
	});

	// Feed each socket connect to `handle_socket_connect`: it runs the boot
	// load that `boot_session` deferred to the first connect, and resyncs after
	// a load the socket didn't carry (an HTTP fallback, or before a reconnect —
	// notifications sent while the socket was down are lost).
	$effect(() => {
		if (!app) return;
		const current_app = app;
		const connect_time = current_app.socket.last_connect_time;
		untrack(() => current_app.handle_socket_connect(connect_time));
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
{:else if public_route}
	<!-- about and docs need neither a session nor the daemon -->
	{@render children()}
{:else}
	<div class="gate">
		{#if gate_state === 'checking'}
			<p class="text_50">verifying session...</p>
		{:else if gate_state === 'daemon_unreachable'}
			<Svg data={logo_zzz} size="var(--icon_size_xl)" />
			<h1>zzz</h1>
			<blockquote>nice web things for the tired 💤</blockquote>
			<div class="width_atmost_sm">
				<Alert status="error">
					<p class="mt_0 mb_sm"><strong>This page needs the zzz daemon.</strong></p>
					<p class="mb_sm">Start it, then reload:</p>
					<p class="row gap_sm mb_sm">
						<code>zzz daemon start</code>
						<CopyToClipboard text="zzz daemon start" />
					</p>
					<p class="mb_sm">(or run <code>zzz</code> to start it and open a browser)</p>
					<p class="row gap_sm mb_0">
						<span>in a zzz checkout:</span>
						<code>cargo xtask dev</code>
						<CopyToClipboard text="cargo xtask dev" />
					</p>
				</Alert>
			</div>
			<p>
				The <a href={resolve('/about')}>about page</a> and <a href={resolve('/docs')}>docs</a> work
				without it.
			</p>
		{:else if gate_state === 'bootstrap'}
			<h1>zzz</h1>
			<p>No accounts exist yet. Create the first admin account.</p>
			<p>
				The bootstrap token is in the file the daemon's <code>FUZ_BOOTSTRAP_TOKEN_PATH</code> names:
			</p>
			<ul>
				<li class="row gap_sm">
					<code>cat ~/.zzz/bootstrap_token</code>
					<CopyToClipboard text="cat ~/.zzz/bootstrap_token" />
					<span>(the <code>zzz</code> CLI)</span>
				</li>
				<li class="row gap_sm">
					<code>cat .zzz/bootstrap_token</code>
					<CopyToClipboard text="cat .zzz/bootstrap_token" />
					<span>(<code>cargo xtask dev</code>, in the checkout)</span>
				</li>
			</ul>
			<p>
				Missing? It's deleted once an admin exists — <code>zzz init</code> creates a new one, then
				restart the daemon.
			</p>
			<BootstrapForm redirect_on_bootstrap={auth_redirect} />
		{:else}
			<h1>zzz</h1>
			<div class="width_atmost_sm">
				<LoginForm redirect_on_login={auth_redirect} />
			</div>
			<p class="text_50">
				No account yet? <code>zzz init</code> recreates the bootstrap token if it's gone (it's
				deleted once the first admin exists); then restart the daemon.
			</p>
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
