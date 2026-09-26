import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelte_preprocess_mdz } from '@fuzdev/mdz/svelte_preprocess_mdz.js';
import { svelte_preprocess_fuz_code } from '@fuzdev/fuz_code/svelte_preprocess_fuz_code.js';
import { execSync } from 'node:child_process';
// TODO debugging
// import {create_csp_directives} from '@fuzdev/fuz_ui/csp.js';
// import {csp_directives_of_fuzdev} from '@fuzdev/fuz_ui/csp_of_fuzdev.js';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: [svelte_preprocess_mdz(), svelte_preprocess_fuz_code(), vitePreprocess()],
	compilerOptions: { runes: true },
	vitePlugin: { inspector: true },
	kit: {
		// `200.html` is the SPA shell for every route that isn't prerendered
		// (dynamic routes like `/chats/[chat_id]`); zzzd serves it as the static
		// fallback (`crates/zzz_server/src/static_files.rs`, which names the file)
		adapter: adapter({ fallback: '200.html' }),
		paths: { relative: false }, // use root-absolute paths for SSR path comparison: https://svelte.dev/docs/kit/configuration#paths
		alias: { $routes: 'src/routes', '@fuzdev/zzz': 'src/lib' },
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
	}
};
