import {z} from 'zod';

/** See `app.providers.names` for the available names at runtime. */
export const ProviderName = z.enum(['claude', 'chatgpt', 'gemini']);
export type ProviderName = z.infer<typeof ProviderName>;

// Provider-specific data schemas
export const ProviderDataClaude = z.strictObject({
	type: z.literal('claude'),
	value: z.any().optional().default({}),
});
export type ProviderDataClaude = z.infer<typeof ProviderDataClaude>;

export const ProviderDataChatgpt = z.strictObject({
	type: z.literal('chatgpt'),
	value: z.any().optional().default({}),
});
export type ProviderDataChatgpt = z.infer<typeof ProviderDataChatgpt>;

export const ProviderDataGemini = z.strictObject({
	type: z.literal('gemini'),
	value: z.strictObject({
		text: z.string(),
		candidates: z.array(z.any()).nullable().optional(),
		function_calls: z.array(z.any()).nullable().optional(),
		prompt_feedback: z.any().nullable().optional(),
		usage_metadata: z.any().nullable().optional(),
	}),
});
export type ProviderDataGemini = z.infer<typeof ProviderDataGemini>;

export const ProviderDataSchema = z.discriminatedUnion('type', [
	ProviderDataClaude,
	ProviderDataChatgpt,
	ProviderDataGemini,
]);
export type ProviderData = z.infer<typeof ProviderDataSchema>;

export const PROVIDER_ERROR_NEEDS_API_KEY = 'needs API key';

export const ProviderStatus = z.discriminatedUnion('available', [
	z.strictObject({
		name: z.string(),
		available: z.literal(true),
		checked_at: z.number(),
	}),
	z.strictObject({
		name: z.string(),
		available: z.literal(false),
		error: z.string(),
		checked_at: z.number(),
	}),
]);
export type ProviderStatus = z.infer<typeof ProviderStatus>;
