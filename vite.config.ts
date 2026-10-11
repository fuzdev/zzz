import { availableParallelism } from 'node:os';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelte_preprocess_mdz } from '@fuzdev/mdz/svelte_preprocess_mdz.ts';
import { svelte_preprocess_fuz_code } from '@fuzdev/fuz_code/svelte_preprocess_fuz_code.ts';
import { vite_plugin_fuz_css } from '@fuzdev/fuz_css/vite_plugin_fuz_css.ts';
import svelte_docinfo from 'svelte-docinfo/vite.js';
import { vite_plugin_pkg_json } from '@fuzdev/fuz_ui/vite_plugin_pkg_json.ts';
// TODO debugging
// import {create_csp_directives} from '@fuzdev/fuz_ui/csp.ts';
// import {csp_directives_of_fuzdev} from '@fuzdev/fuz_ui/csp_of_fuzdev.ts';

const max_workers = Math.max(1, Math.ceil(availableParallelism() / 2));

/**
 * Cross-backend integration projects. One project per spawned backend;
 * each runs the shared `*.cross.test.ts` files against its own
 * bootstrapped binary. The `globalSetup` picks the right `BackendConfig`
 * factory from the project's `name` (vitest 4 passes the `TestProject`
 * to globalSetup) and provides the `BootstrappedBackendHandle` to test
 * files via vitest's `provide`/`inject` channel.
 *
 * The proxy variant is a separate project because flipping
 * `ZZZ_TRUSTED_PROXIES` on the Rust backend can't be done mid-run
 * (parsed once at boot) — the test file expects a backend spawned
 * with the trust list already configured.
 */
const make_cross_backend_project = (name: string, proxy_only = false) => ({
	extends: true as const,
	test: {
		name,
		include: proxy_only
			? ['src/test/cross_backend/proxy.cross.test.ts']
			: ['src/test/cross_backend/*.cross.test.ts'],
		exclude: proxy_only ? [] : ['src/test/cross_backend/proxy.cross.test.ts'],
		globalSetup: ['./src/test/cross_backend/global_setup.ts'],
		isolate: false,
		fileParallelism: false,
		sequence: { groupOrder: 3 }
	}
});

// The `cross_backend_*` projects spawn the real Rust `zzz_server` binary via
// `globalSetup` (needs a built rust binary + a `zzz_test*` Postgres DB). Gate
// them behind `FUZ_TEST_CROSS_BACKEND=1` so a bare `gro test` stays a fast,
// infra-free unit+db run and never spawns. Set the flag to opt in — required
// both for `gro test` to include them and for explicit
// `npx vitest run --project cross_backend_*` runs.
const cross_backend_enabled = !!process.env.FUZ_TEST_CROSS_BACKEND;

const cross_backend_projects = cross_backend_enabled
	? [
			make_cross_backend_project('cross_backend_rust'),
			make_cross_backend_project('cross_backend_rust_proxy', true)
		]
	: [];

export default defineConfig(({ mode }) => ({
	plugins: [
		sveltekit({
			preprocess: [svelte_preprocess_mdz(), svelte_preprocess_fuz_code(), vitePreprocess()],
			compilerOptions: { runes: true },
			inspector: true,
			// `200.html` is the SPA shell for every route that isn't prerendered
			// (dynamic routes like `/chats/[chat_id]`); zzzd serves it as the static
			// fallback (`crates/zzz_server/src/static_files.rs`, which names the file)
			adapter: adapter({ fallback: '200.html' }),
			paths: { relative: false }, // use root-absolute paths for SSR path comparison: https://svelte.dev/docs/kit/configuration#paths
			// csp: {
			// 	directives: create_csp_directives({
			// 		extend: [csp_directives_of_fuzdev],
			// 		directives: {
			// 			'connect-src': [
			// 				'self',
			// 				// TODO switch to use env vars
			// 				'ws://localhost:4461',
			// 			],
			// 			'frame-src': [
			// 				'self',
			// 				// enable iframing for the example sites
			// 				'https://css.fuz.dev/',
			// 				'https://fuz.dev/',
			// 				'https://*.fuz.dev/',
			// 			],
			// 		},
			// 	}),
			// },
			// dynamic routes inherit `prerender = true` from the root layout but have
			// no crawlable entries — they're served by the fallback shell instead
			prerender: { handleUnseenRoutes: 'ignore' },
			version: { name: execSync('git rev-parse HEAD').toString().trim() }
		}),
		svelte_docinfo(),
		vite_plugin_fuz_css(),
		vite_plugin_pkg_json()
	],
	test: {
		// stubs the page global SvelteKit's `$app/env/public` dev module reads
		setupFiles: ['./src/test/sveltekit_env_setup.ts'],
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/test/**/*.test.ts'],
					exclude: ['src/test/**/*.db.test.ts', 'src/test/**/*.cross.test.ts'],
					maxWorkers: max_workers,
					sequence: { groupOrder: 1 }
				}
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: { groupOrder: 2 }
				}
			},
			...cross_backend_projects
		]
	},
	// In test mode, use browser conditions so Svelte's mount() resolves to the client version
	resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
	optimizeDeps: { exclude: ['@fuzdev/blake3-wasm'] },
	server: {
		// pinned, never the next free port: `FUZ_ALLOWED_ORIGINS` names this exact origin
		port: 5173,
		strictPort: true,
		// Vite watches the whole root with one inotify watch per file, so build output and
		// caches (the Rust `target/` alone is tens of thousands of files) exhaust the
		// user's `max_user_watches` budget. Merged with SvelteKit's own ignores.
		watch: {
			ignored: ['**/target/**', '**/.fuz/**', '**/.gro/**', '**/build/**', '**/.zzz/**']
		},
		proxy: {
			// `ws` too, so the `/api/ws` fallback works in dev - kit 3 writes the dev env to
			// `.svelte-kit/generated/`, and a test run rewrites it with test-mode values
			'/api': {
				target: `http://localhost:${process.env.PUBLIC_ZZZ_SERVER_PROXIED_PORT || '4461'}`,
				ws: true
			},
			// `/health` lives outside `/api`; proxy it to the daemon so the gate's
			// liveness probe hits zzzd in dev, not the SvelteKit SPA fallback.
			'/health': `http://localhost:${process.env.PUBLIC_ZZZ_SERVER_PROXIED_PORT || '4461'}`
		}
	}
}));
