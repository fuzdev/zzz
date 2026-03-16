import type {CreateGroConfig} from '@fuzdev/gro';
import {gro_plugin_deno_compile} from '@fuzdev/gro/gro_plugin_deno_compile.js';
import {gro_plugin_deno_server} from '@fuzdev/gro/gro_plugin_deno_server.js';

// eslint-disable-next-line @typescript-eslint/require-await
const config: CreateGroConfig = async (base_config) => {
	const base_plugins = base_config.plugins;
	base_config.plugins = async (ctx) => {
		const plugins = (await base_plugins(ctx)).filter((p) => p.name !== 'gro_plugin_server');
		plugins.push(
			gro_plugin_deno_server({
				entry: 'src/lib/server/server.ts',
				port: 8999,
				permissions: ['--allow-net', '--allow-read', '--allow-write', '--allow-env'],
				flags: ['--no-check', '--sloppy-imports'],
			}),
		);
		return [
			...plugins,
			gro_plugin_deno_compile({
				entry: 'src/lib/zzz/main.ts',
				output_name: 'zzz',
				flags: [
					'--no-check',
					'--sloppy-imports',
					'--include',
					'../../blake3/crates/blake3_wasm/pkg/deno', // embeds WASM binary for blake3
				],
			}),
		];
	};

	return base_config;
};

export default config;
