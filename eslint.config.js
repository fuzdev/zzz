import {configs /*, ts_config*/} from '@ryanatkn/eslint-config';

// ts_config.rules['no-console'] = 1;

export default [
	...configs,
	{
		// `$bindable()` is a Svelte 5 marker, not a default value, but the rule
		// can't tell them apart and flags every bindable required prop.
		files: ['**/*.svelte'],
		rules: {
			'@typescript-eslint/no-useless-default-assignment': 'off',
		},
	},
];
