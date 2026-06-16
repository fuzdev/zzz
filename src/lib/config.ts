import type {ZzzOptionsCreator} from './config_helpers.ts';
import {models_default, providers_default, BOTS_DEFAULT} from './config_defaults.ts';

// TODO hacky and temporary, just thinking through designs
// some of the model param defaults definitely do not belong her

// TODO refactor currently this is imported directly by frontend and backend, but we probably only want to forward a serialized subset to the client -
// maybe move to zzz.config.ts in the repo root, and genfile for the frontend config
const config: ZzzOptionsCreator = () => {
	return {
		providers: providers_default,
		models: models_default,
		bots: BOTS_DEFAULT,
	};
};

export default config; // TODO I guess this acts like a seed file? `zzz.config.ts`? could we create a config helper with gro? (see the equivalent code in fuz_gitops)
