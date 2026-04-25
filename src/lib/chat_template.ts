import type {Uuid} from '@fuzdev/fuz_util/id.js';

// TODO @many refactor with db

/**
 * Represents a template for creating a new chat with specific model configurations
 */
export interface ChatTemplate {
	id: Uuid;
	/** Human-readable name of the template. */
	name: string;
	/** List of model names to include in chats created from this template. */
	model_names: Array<string>;
}
