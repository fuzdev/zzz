import {
	array,
	literal,
	nullable,
	number,
	object,
	one_of,
	optional,
	string,
	unknown,
	variant,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

/** See `app.providers.names` for the available names at runtime. */
export const ProviderName = one_of(['claude', 'chatgpt', 'gemini']);
export type ProviderName = Infer<typeof ProviderName>;

// Provider-specific data schemas
export const ProviderDataClaude = object({
	type: literal('claude'),
	value: with_default_fn(unknown, () => ({}))
});
export type ProviderDataClaude = Infer<typeof ProviderDataClaude>;

export const ProviderDataChatgpt = object({
	type: literal('chatgpt'),
	value: with_default_fn(unknown, () => ({}))
});
export type ProviderDataChatgpt = Infer<typeof ProviderDataChatgpt>;

export const ProviderDataGemini = object({
	type: literal('gemini'),
	value: object({
		text: string,
		candidates: optional(nullable(array(unknown))),
		function_calls: optional(nullable(array(unknown))),
		prompt_feedback: optional(nullable(unknown)),
		usage_metadata: optional(nullable(unknown))
	})
});
export type ProviderDataGemini = Infer<typeof ProviderDataGemini>;

export const ProviderDataSchema = variant('type', [
	ProviderDataClaude,
	ProviderDataChatgpt,
	ProviderDataGemini
]);
export type ProviderData = Infer<typeof ProviderDataSchema>;

export const PROVIDER_ERROR_NEEDS_API_KEY = 'needs API key';

/**
 * `data.reason` on a completion error caused by a non-2xx response from the
 * provider's API — `data.status` carries the upstream HTTP status.
 */
export const PROVIDER_ERROR_REASON_HTTP = 'provider_http_error';

/**
 * Reads the upstream HTTP status from a completion error's `data`.
 *
 * @param data - the JSON-RPC error's `data`
 * @returns the provider API's HTTP status, or `null` when the error wasn't a non-2xx response
 */
export const to_provider_http_status = (data: unknown): number | null => {
	if (typeof data !== 'object' || data === null) return null;
	const { reason, status } = data as { reason?: unknown; status?: unknown };
	return reason === PROVIDER_ERROR_REASON_HTTP && typeof status === 'number' ? status : null;
};

export const ProviderStatus = variant('available', [
	object({
		name: string,
		available: literal(true),
		checked_at: number
	}),
	object({
		name: string,
		available: literal(false),
		error: string,
		checked_at: number
	})
]);
export type ProviderStatus = Infer<typeof ProviderStatus>;
