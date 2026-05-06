import type {Gen} from '@fuzdev/gro';

import {create_zzz_app_surface_spec} from './auth_attack_surface_helpers.js';

export const gen: Gen = () => {
	return JSON.stringify(create_zzz_app_surface_spec().surface);
};
