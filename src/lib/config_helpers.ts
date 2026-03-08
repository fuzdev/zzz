import type {ProviderJsonInput} from './provider.svelte.js';
import type {ModelJsonInput, ModelName} from './model.svelte.js';

// TODO expand similar to gitops/gro config

// TODO is currently synchronous because it's imported on the client, could be made async if the client uses a different sourcing strategy
export type ZzzOptionsCreator = () => ZzzOptions;

/**
 * @json
 */
export interface ZzzOptions {
	providers: Array<ProviderJsonInput>;
	models: Array<ModelJsonInput>;
	system_message: string;
	output_token_max: number;
	temperature: number | undefined;
	seed: number | undefined;
	top_k: number | undefined;
	top_p: number | undefined;
	frequency_penalty: number | undefined;
	presence_penalty: number | undefined;
	stop_sequences: Array<string> | undefined;
	// TODO name?
	bots: {
		/**
		 * Names things.
		 */
		namerbot: ModelName;
	};
}
