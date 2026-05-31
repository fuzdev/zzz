import {availableParallelism} from 'node:os';
import {defineConfig} from 'vite';
import {sveltekit} from '@sveltejs/kit/vite';
import {vite_plugin_fuz_css} from '@fuzdev/fuz_css/vite_plugin_fuz_css.js';
import svelte_docinfo from 'svelte-docinfo/vite.js';

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
		sequence: {groupOrder: 3},
	},
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
			make_cross_backend_project('cross_backend_rust_proxy', true),
		]
	: [];

export default defineConfig(({mode}) => ({
	plugins: [vite_plugin_fuz_css(), sveltekit(), svelte_docinfo()],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/test/**/*.test.ts'],
					exclude: ['src/test/**/*.db.test.ts', 'src/test/**/*.cross.test.ts'],
					maxWorkers: max_workers,
					sequence: {groupOrder: 1},
				},
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 2},
				},
			},
			...cross_backend_projects,
		],
	},
	// In test mode, use browser conditions so Svelte's mount() resolves to the client version
	resolve: mode === 'test' ? {conditions: ['browser']} : undefined,
	optimizeDeps: {exclude: ['@fuzdev/blake3_wasm']},
	server: {
		proxy: {
			'/api': `http://localhost:${process.env.PUBLIC_ZZZ_SERVER_PROXIED_PORT || '4461'}`,
		},
	},
}));
