import { test, assert } from 'vitest';

import {
	providers_default,
	models_default,
	chat_template_defaults,
	BOTS_DEFAULT
} from '$lib/config_defaults.ts';

/** Claude model ids Anthropic has retired — the API rejects them with a 404. */
const RETIRED_CLAUDE_MODELS = [
	'claude-opus-4-1-20250805',
	'claude-opus-4-1',
	'claude-3-7-sonnet-20250219',
	'claude-3-5-haiku-20241022',
	'claude-3-5-haiku-latest',
	'claude-3-opus-20240229',
	'claude-3-5-sonnet-20241022',
	'claude-3-5-sonnet-20240620',
	'claude-3-haiku-20240307',
	'claude-3-sonnet-20240229',
	'claude-2.1'
];

test('all model provider_names exist in providers_default', () => {
	// Extract all unique provider names from models
	const model_provider_names = new Set(models_default.map((model) => model.provider_name));

	// Extract all provider names from providers
	const provider_names = new Set(providers_default.map((provider) => provider.name));

	// Check that each model's provider exists
	for (const provider_name of model_provider_names) {
		assert.ok(
			provider_names.has(provider_name),
			`Provider "${provider_name}" used in models_default does not exist in providers_default`
		);
	}
});

test('all chat template model_names exist in models_default', () => {
	// Extract all unique model names from chat templates
	const template_model_names = new Set(
		chat_template_defaults.flatMap((template) => template.model_names)
	);

	// Extract all model names from models
	const model_names = new Set(models_default.map((model) => model.name));

	// Check that each template model exists
	const missing_models: Array<string> = [];
	for (const model_name of template_model_names) {
		if (!model_names.has(model_name)) {
			missing_models.push(model_name);
		}
	}

	assert.deepEqual(
		missing_models,
		[],
		`The following models in chat_template_defaults do not exist in models_default: ${missing_models.join(', ')}`
	);
});

test('no default model, bot, or chat template names a retired Claude model', () => {
	const names = [
		...models_default.map((model) => model.name),
		...Object.values(BOTS_DEFAULT),
		...chat_template_defaults.flatMap((template) => template.model_names)
	];
	const retired = names.filter((name) => RETIRED_CLAUDE_MODELS.includes(name));
	assert.deepEqual(retired, [], `retired Claude models in the defaults: ${retired.join(', ')}`);
});

test('every default bot model exists in models_default', () => {
	const model_names = new Set(models_default.map((model) => model.name));
	for (const [bot, model_name] of Object.entries(BOTS_DEFAULT)) {
		assert.ok(model_names.has(model_name), `${bot} model "${model_name}" is not in models_default`);
	}
});
