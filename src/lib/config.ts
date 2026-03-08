import type {ZzzOptionsCreator} from './config_helpers.js';
import {
	models_default,
	providers_default,
	SYSTEM_MESSAGE_DEFAULT,
	OUTPUT_TOKEN_MAX_DEFAULT,
	TEMPERATURE_DEFAULT,
	SEED_DEFAULT,
	TOP_K_DEFAULT,
	TOP_P_DEFAULT,
	FREQUENCY_PENALTY_DEFAULT,
	PRESENCE_PENALTY_DEFAULT,
	STOP_SEQUENCES_DEFAULT,
	BOTS_DEFAULT,
} from './config_defaults.js';

// TODO hacky and temporary, just thinking through designs
// some of the model param defaults definitely do not belong her

// TODO refactor currently this is imported directly by frontend and backend, but we probably only want to forward a serialized subset to the client -
// maybe move to zzz.config.ts in the repo root, and genfile for the frontend config
const config: ZzzOptionsCreator = () => {
	return {
		providers: providers_default,
		models: models_default,
		system_message: SYSTEM_MESSAGE_DEFAULT,
		output_token_max: OUTPUT_TOKEN_MAX_DEFAULT,
		temperature: TEMPERATURE_DEFAULT,
		seed: SEED_DEFAULT,
		top_k: TOP_K_DEFAULT,
		top_p: TOP_P_DEFAULT,
		frequency_penalty: FREQUENCY_PENALTY_DEFAULT,
		presence_penalty: PRESENCE_PENALTY_DEFAULT,
		stop_sequences: STOP_SEQUENCES_DEFAULT,
		bots: BOTS_DEFAULT,
	};
};

export default config; // TODO I guess this acts like a seed file? `zzz.config.ts`? could we create a config helper with gro? (see the equivalent code in fuz_gitops)
