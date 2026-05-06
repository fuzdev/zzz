import {resolve} from '$app/paths';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

// TODO think about refactoring with related code

export const to_chats_url = (chat_id: Uuid | null): string =>
	chat_id ? resolve(`/chats/${chat_id}`) : resolve('/chats');

export const to_prompts_url = (chat_id: Uuid | null): string =>
	chat_id ? resolve(`/prompts/${chat_id}`) : resolve('/prompts');
