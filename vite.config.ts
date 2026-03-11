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
					exclude: ['src/test/**/*.db.test.ts'],
					maxWorkers: max_workers,
					sequence: {groupOrder: 2},
				},
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 1},
				},
			},
		],
	},
	// In test mode, use browser conditions so Svelte's mount() resolves to the client version
	resolve: mode === 'test' ? {conditions: ['browser']} : undefined,
	server: {
		proxy: {
			'/api': 'http://localhost:8999', // equal to `PUBLIC_SERVER_HOST + ':' + PUBLIC_SERVER_PROXIED_PORT`
		},
	},
}));
