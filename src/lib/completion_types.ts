import {z} from 'zod';
import {DatetimeNow} from '@fuzdev/fuz_util/datetime.js';

import {ProviderName, ProviderDataSchema} from './provider_types.js';

// TODO any restrictions?
export const CompletionRole = z.string(); // branding is too unwieldy at data declaration sites
export type CompletionRole = z.infer<typeof CompletionRole>;

export const CompletionMessage = z.looseObject({
	role: CompletionRole,
	content: z.string(), // TODO maybe rename to `text` or something, see the APIs, they have different names
});
export type CompletionMessage = z.infer<typeof CompletionMessage>;

export const CompletionRequest = z.strictObject({
	created: DatetimeNow,
	provider_name: ProviderName,
	model: z.string(),
	prompt: z.string(),
	// TODO rename? this API is going to change likely to fit better with the responses API
	completion_messages: z.array(CompletionMessage).optional(),
});
export type CompletionRequest = z.infer<typeof CompletionRequest>;

export const CompletionResponse = z.strictObject({
	created: DatetimeNow,
	provider_name: ProviderName,
	model: z.string(),
	data: ProviderDataSchema,
});
export type CompletionResponse = z.infer<typeof CompletionResponse>;
