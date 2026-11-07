import {
	array,
	loose_object,
	object,
	optional,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { DatetimeNow } from './datetime.ts';
import { ProviderName, ProviderDataSchema } from './provider_types.ts';

// TODO any restrictions?
export const CompletionRole = string; // branding is too unwieldy at data declaration sites
export type CompletionRole = Infer<typeof CompletionRole>;

export const CompletionMessage = loose_object({
	role: CompletionRole,
	content: string // TODO maybe rename to `text` or something, see the APIs, they have different names
});
export type CompletionMessage = Infer<typeof CompletionMessage>;

export const CompletionRequest = object({
	created: DatetimeNow,
	provider_name: ProviderName,
	model: string,
	prompt: string,
	// TODO rename? this API is going to change likely to fit better with the responses API
	completion_messages: optional(array(CompletionMessage))
});
export type CompletionRequest = Infer<typeof CompletionRequest>;

export const CompletionResponse = object({
	created: DatetimeNow,
	provider_name: ProviderName,
	model: string,
	data: ProviderDataSchema
});
export type CompletionResponse = Infer<typeof CompletionResponse>;
