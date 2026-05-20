import {describe_standard_integration_tests} from '@fuzdev/fuz_app/testing/integration.js';
import {describe_standard_admin_integration_tests} from '@fuzdev/fuz_app/testing/admin_integration.js';
import {describe_rate_limiting_tests} from '@fuzdev/fuz_app/testing/rate_limiting.js';
import {describe_round_trip_validation} from '@fuzdev/fuz_app/testing/round_trip.js';
import {describe_rpc_round_trip_tests} from '@fuzdev/fuz_app/testing/rpc_round_trip.js';
import {describe_data_exposure_tests} from '@fuzdev/fuz_app/testing/data_exposure.js';
import {default_in_process_suite_options} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {create_role_schema, ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';
import type {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import {stub} from '@fuzdev/fuz_app/testing/stubs.js';
import {fuz_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';

import {create_zzz_app_route_specs, build_rpc_endpoint_specs} from '$lib/server/zzz_route_specs.js';

import {db_factories} from '../../db_fixture.js';
import {create_zzz_app_surface_spec} from './auth_attack_surface_helpers.js';

/** Stub deps — handlers are never called by auth integration tests. */
const zzz_rpc_stub_deps = {
	backend: stub,
};

/** Route factory with stub deps for composable suites. */
const create_zzz_test_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_zzz_app_route_specs(ctx, {
		zzz: zzz_rpc_stub_deps,
		version: '',
		get_uptime_ms: () => 0,
	});

/** RPC endpoint factory — closes over `ctx` for the standard admin bundle. */
const zzz_rpc_endpoints = (ctx: AppServerContext) =>
	build_rpc_endpoint_specs(ctx, zzz_rpc_stub_deps);

/** zzz uses default admin/keeper roles — no app-specific extensions. */
const zzz_roles = create_role_schema([]);

// -- Composable suites --

/**
 * Bootstrap config mirroring production wiring (`create_zzz_app.ts`) —
 * synthetic `token_path` since `create_test_app` flips `bootstrap_lock` to
 * `true` via `bootstrap_test_keeper`, so the wire behavior is 403
 * `ALREADY_BOOTSTRAPPED` regardless of token presence.
 */
const zzz_test_bootstrap = {mode: 'live', token_path: '/test/bootstrap.token'} as const;

describe_standard_integration_tests(
	default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		bootstrap: zzz_test_bootstrap,
	}),
);

describe_standard_admin_integration_tests({
	...default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		extra_keeper_roles: [ROLE_ADMIN],
		bootstrap: zzz_test_bootstrap,
	}),
	roles: zzz_roles,
});

describe_rate_limiting_tests({
	...default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		bootstrap: zzz_test_bootstrap,
	}),
	db_factories,
});

describe_round_trip_validation({
	...default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		bootstrap: zzz_test_bootstrap,
	}),
	skip_routes: [
		'GET /api/rpc', // covered by describe_rpc_round_trip_tests
		'POST /api/rpc',
	],
});

describe_rpc_round_trip_tests({
	...default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		bootstrap: zzz_test_bootstrap,
	}),
	// Domain handlers use a throwing stub Backend — the RPC dispatcher catches
	// all throws and returns well-formed JSON-RPC error responses, which the
	// round-trip test accepts. Only DiskfileDirectoryPath inputs need overrides
	// because the schema generator can't produce trailing-slash absolute paths.
	input_overrides: new Map([
		['workspace_open', {path: '/test/dir/'}],
		['workspace_close', {path: '/test/dir/'}],
	]),
});

describe_data_exposure_tests(
	default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs: create_zzz_test_route_specs,
		surface_source: {kind: 'inline', spec: create_zzz_app_surface_spec()},
		bootstrap: zzz_test_bootstrap,
	}),
);
