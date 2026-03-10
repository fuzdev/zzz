import {test, assert} from 'vitest';

import {providers_default, models_default, chat_template_defaults} from '$lib/config_defaults.js';

test('all model provider_names exist in providers_default', () => {
	// Extract all unique provider names from models
	const model_provider_names = new Set(models_default.map((model) => model.provider_name));

	// Extract all provider names from providers
	const provider_names = new Set(providers_default.map((provider) => provider.name));

	// Check that each model's provider exists
	for (const provider_name of model_provider_names) {
		assert.ok(
			provider_names.has(provider_name),
			`Provider "${provider_name}" used in models_default does not exist in providers_default`,
		);
	}
});

test('all chat template model_names exist in models_default', () => {
	// Extract all unique model names from chat templates
	const template_model_names = new Set(
		chat_template_defaults.flatMap((template) => template.model_names),
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
		`The following models in chat_template_defaults do not exist in models_default: ${missing_models.join(', ')}`,
	);
});
