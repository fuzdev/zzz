import type {CreateGroConfig} from '@fuzdev/gro';
import {gro_plugin_deno_compile} from '@fuzdev/gro/gro_plugin_deno_compile.js';

const config: CreateGroConfig = async (base_config) => {
	const base_plugins = base_config.plugins;
	base_config.plugins = async (ctx) => {
		const plugins = await base_plugins(ctx);
		return [
			...plugins,
			gro_plugin_deno_compile({
				entry: 'src/lib/zzz/main.ts',
				output_name: 'zzz',
				flags: ['--no-check', '--sloppy-imports'],
			}),
		];
	};

	return base_config;
};

export default config;
