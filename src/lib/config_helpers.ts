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
	// TODO name?
	bots: {
		/**
		 * Names things.
		 */
		namerbot: ModelName;
	};
}
