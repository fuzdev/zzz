import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';
import {svelte_preprocess_mdz} from '@fuzdev/fuz_ui/svelte_preprocess_mdz.js';
import {svelte_preprocess_fuz_code} from '@fuzdev/fuz_code/svelte_preprocess_fuz_code.js';
// TODO debugging
// import {create_csp_directives} from '@fuzdev/fuz_ui/csp.js';
// import {csp_trusted_sources_of_fuzdev} from '@fuzdev/fuz_ui/csp_of_fuzdev.js';

// Dynamically import adapter based on the ZZZ_BUILD env var.
// ZZZ_BUILD=node for production Node server, otherwise static for GitHub Pages.
const build_mode_raw = process.env.ZZZ_BUILD;
// 'static' | 'node'
const build_mode = build_mode_raw === 'node' ? 'node' : 'static';

const adapter_module =
	build_mode === 'node'
		? await import('@sveltejs/adapter-node')
		: await import('@sveltejs/adapter-static');

const adapter = adapter_module.default;

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: [svelte_preprocess_mdz(), svelte_preprocess_fuz_code(), vitePreprocess()],
	compilerOptions: {runes: true},
	vitePlugin: {inspector: true},
	kit: {
		adapter: adapter(),
		paths: {relative: false}, // use root-absolute paths for SSR path comparison: https://svelte.dev/docs/kit/configuration#paths
		alias: {$routes: 'src/routes', '@fuzdev/zzz': 'src/lib'},
		// csp: {
		// 	directives: create_csp_directives({
		// 		trusted_sources: csp_trusted_sources_of_fuzdev,
		// 		directives: {
		// 			'connect-src': [
		// 				'self',
		// 				// TODO switch to use env vars
		// 				'ws://localhost:8999',
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
		prerender: {
			handleUnseenRoutes: 'ignore',
		},
	},
};
