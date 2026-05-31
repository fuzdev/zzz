import type {CreateGroConfig} from '@fuzdev/gro';

// eslint-disable-next-line @typescript-eslint/require-await
const config: CreateGroConfig = async (base_config) => {
	const base_plugins = base_config.plugins;
	base_config.plugins = async (ctx) => {
		// Drop gro's default dev server — zzz's backend is the Rust `zzzd`
		// binary, built with `cargo` and run via `cargo xtask dev` (dev) or
		// `zzz daemon start` (prod), not gro's Node server.
		return (await base_plugins(ctx)).filter((p) => p.name !== 'gro_plugin_server');
	};

	return base_config;
};

export default config;
