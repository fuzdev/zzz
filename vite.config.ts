import {availableParallelism} from 'node:os';
import {defineConfig} from 'vite';
import {sveltekit} from '@sveltejs/kit/vite';
import {vite_plugin_library_well_known} from '@fuzdev/fuz_ui/vite_plugin_library_well_known.js';

const max_workers = Math.max(1, Math.ceil(availableParallelism() / 2));

export default defineConfig(({mode}) => ({
	plugins: [sveltekit(), vite_plugin_library_well_known()],
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
			// Cross-backend integration projects. One project per spawned
			// backend; each runs the shared `*.cross.test.ts` files against
			// its own bootstrapped binary. The `globalSetup` picks the
			// right `BackendConfig` factory via `ZZZ_CROSS_BACKEND_NAME`
			// and provides the `BootstrappedBackendHandle` to test files
			// via vitest's `provide`/`inject` channel. The proxy variant
			// is a separate project because flipping `ZZZ_TRUSTED_PROXIES`
			// on the Rust backend can't be done mid-run (parsed once at
			// boot) — the test file expects a backend spawned with the
			// trust list already configured.
			{
				extends: true,
				test: {
					name: 'cross_backend_ts_deno',
					include: ['src/test/cross_backend/*.cross.test.ts'],
					exclude: ['src/test/cross_backend/proxy.cross.test.ts'],
					globalSetup: ['./src/test/cross_backend/global_setup.ts'],
					env: {ZZZ_CROSS_BACKEND_NAME: 'deno'},
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 3},
				},
			},
			{
				extends: true,
				test: {
					name: 'cross_backend_ts_node',
					include: ['src/test/cross_backend/*.cross.test.ts'],
					exclude: ['src/test/cross_backend/proxy.cross.test.ts'],
					globalSetup: ['./src/test/cross_backend/global_setup.ts'],
					env: {ZZZ_CROSS_BACKEND_NAME: 'node'},
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 3},
				},
			},
			{
				extends: true,
				test: {
					name: 'cross_backend_rust',
					include: ['src/test/cross_backend/*.cross.test.ts'],
					exclude: ['src/test/cross_backend/proxy.cross.test.ts'],
					globalSetup: ['./src/test/cross_backend/global_setup.ts'],
					env: {ZZZ_CROSS_BACKEND_NAME: 'rust'},
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 3},
				},
			},
			{
				extends: true,
				test: {
					name: 'cross_backend_rust_proxy',
					include: ['src/test/cross_backend/proxy.cross.test.ts'],
					globalSetup: ['./src/test/cross_backend/global_setup.ts'],
					env: {ZZZ_CROSS_BACKEND_NAME: 'rust_proxy'},
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 3},
				},
			},
		],
	},
	// In test mode, use browser conditions so Svelte's mount() resolves to the client version
	resolve: mode === 'test' ? {conditions: ['browser']} : undefined,
	optimizeDeps: {exclude: ['@fuzdev/blake3_wasm']},
	server: {
		proxy: {
			'/api': `http://localhost:${process.env.PUBLIC_ZZZ_SERVER_PROXIED_PORT || '8999'}`,
		},
	},
}));
