import {describe_standard_attack_surface_tests} from '@fuzdev/fuz_app/testing/attack_surface.js';
import {describe_rpc_attack_surface_tests} from '@fuzdev/fuz_app/testing/rpc_attack_surface.js';

import {
	create_zzz_app_surface_spec,
	resolve_zzz_fixture_path,
} from './auth_attack_surface_helpers.js';

describe_standard_attack_surface_tests({
	build: create_zzz_app_surface_spec,
	snapshot_path: resolve_zzz_fixture_path('auth_attack_surface.json'),
	expected_public_routes: [
		'GET /health',
		'GET /api/account/status',
		'POST /api/account/login',
		'POST /api/account/bootstrap',
		'GET /api/rpc',
		'POST /api/rpc',
	],
	expected_api_middleware: [
		'host_validation',
		'origin',
		'session',
		'request_context',
		'bearer_auth',
	],
	roles: ['admin', 'keeper'],
	security_policy: {
		public_mutation_allowlist: [
			'POST /api/account/login',
			'POST /api/account/bootstrap',
			'POST /api/rpc',
		],
	},
});

describe_rpc_attack_surface_tests({
	build: create_zzz_app_surface_spec,
	roles: ['admin', 'keeper'],
});
