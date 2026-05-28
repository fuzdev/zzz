import type {z} from 'zod';
import {create_uuid} from '@fuzdev/fuz_util/id.js';

import type {ProviderJsonInput} from './provider.svelte.js';
import type {ModelJson} from './model.svelte.js';
import type {ChatTemplate} from './chat_template.js';

// TODO this is a temporary source of truth, use APIs instead
// TODO @many refactor with db

// Configuration defaults
export const SYSTEM_MESSAGE_DEFAULT =
	'You are a helpful assistant that responds succinctly unless asked for more.';
export const OUTPUT_TOKEN_MAX_DEFAULT = 1000;
export const TEMPERATURE_DEFAULT: number | undefined = undefined;
export const SEED_DEFAULT: number | undefined = undefined;
export const TOP_K_DEFAULT: number | undefined = undefined;
export const TOP_P_DEFAULT: number | undefined = undefined;
export const FREQUENCY_PENALTY_DEFAULT: number | undefined = undefined;
export const PRESENCE_PENALTY_DEFAULT: number | undefined = undefined;
export const STOP_SEQUENCES_DEFAULT: Array<string> | undefined = undefined;
export const BOTS_DEFAULT = {
	namerbot: 'claude-3-5-haiku-20241022',
};

// TODO needs work, hardcoding a bunch of stuff for now, and needs more support for different providers

export const providers_default: Array<ProviderJsonInput> = [
	{
		name: 'claude',
		title: 'Claude',
		url: 'https://docs.anthropic.com/en/home',
		homepage: 'https://claude.ai/',
		company: 'Anthropic',
		api_key_url: 'https://console.anthropic.com/settings/keys',
	},
	{
		name: 'chatgpt',
		title: 'ChatGPT',
		url: 'https://platform.openai.com/docs/overview',
		homepage: 'https://chatgpt.com/',
		company: 'OpenAI',
		api_key_url: 'https://platform.openai.com/api-keys',
	},
	{
		name: 'gemini',
		title: 'Gemini',
		url: 'https://ai.google.dev/gemini-api/docs/',
		homepage: 'https://gemini.google.com/',
		company: 'Google',
		api_key_url: 'https://aistudio.google.com/app/api-keys',
	},
];

// TODO any data here beyond name/provider_name/tags (and probably some future ones) should be fetched from the provider API
// TODO @db refactor with db
export const models_default: Array<z.input<typeof ModelJson>> = [
	// https://docs.claude.com/en/docs/about-claude/models/overview
	{name: 'claude-sonnet-4-5-20250929', provider_name: 'claude', tags: ['smart']}, // name: 'claude-sonnet-4-0'
	{name: 'claude-opus-4-1-20250805', provider_name: 'claude', tags: ['smart', 'smartest']}, // name: 'claude-opus-4-0'
	{name: 'claude-3-5-haiku-20241022', provider_name: 'claude', tags: ['cheap']}, // name: 'claude-3-5-haiku-latest'

	// https://platform.openai.com/docs/models
	{name: 'gpt-5-2025-08-07', provider_name: 'chatgpt', tags: ['smart']},
	{name: 'gpt-5-nano-2025-08-07', provider_name: 'chatgpt', tags: ['cheap', 'cheaper']},
	{name: 'gpt-5-mini-2025-08-07', provider_name: 'chatgpt', tags: ['cheap']},
	{name: 'gpt-4.1-2025-04-14', provider_name: 'chatgpt', tags: ['smart']},

	// https://ai.google.dev/gemini-api/docs/
	{name: 'gemini-2.5-pro', provider_name: 'gemini', tags: ['smart']},
	{name: 'gemini-2.5-flash', provider_name: 'gemini', tags: ['cheap']},
	{name: 'gemini-2.5-flash-lite', provider_name: 'gemini', tags: ['cheap', 'cheaper']},
];

/**
 * Default chat templates available in the application
 */
export const chat_template_defaults: Array<ChatTemplate> = [
	{
		id: create_uuid(),
		name: 'frontier',
		model_names: ['claude-sonnet-4-5-20250929', 'gpt-5-2025-08-07', 'gemini-2.5-pro'],
	},
	{
		id: create_uuid(),
		name: 'cheap frontier',
		model_names: ['claude-3-5-haiku-20241022', 'gpt-5-nano-2025-08-07', 'gemini-2.5-flash-lite'],
	},
	{
		id: create_uuid(),
		name: 'quick test',
		model_names: ['claude-3-5-haiku-20241022', 'gpt-5-nano-2025-08-07', 'gemini-2.5-flash-lite'],
	},
];
