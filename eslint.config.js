import { configs /*, ts_config*/ } from '@ryanatkn/eslint-config';

// ts_config.rules['no-console'] = 1;

export default [
	...configs,
	{
		// Rust artifacts — eslint walks `target/doc/**/*.js` (170 generated files
		// from `cargo doc`), and each one stalls the typescript-eslint project
		// service for ~60s. `crates/` listed defensively even though it has no JS today.
		ignores: ['target', 'crates']
	},
	{
		// `$bindable()` is a Svelte 5 marker, not a default value, but the rule
		// can't tell them apart and flags every bindable required prop.
		files: ['**/*.svelte'],
		rules: {
			'@typescript-eslint/no-useless-default-assignment': 'off'
		}
	}
];
