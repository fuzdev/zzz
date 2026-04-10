import {describe_standard_integration_tests} from '@fuzdev/fuz_app/testing/integration.js';
import {describe_standard_admin_integration_tests} from '@fuzdev/fuz_app/testing/admin_integration.js';
import {describe_rate_limiting_tests} from '@fuzdev/fuz_app/testing/rate_limiting.js';
import {describe_round_trip_validation} from '@fuzdev/fuz_app/testing/round_trip.js';
import {describe_rpc_round_trip_tests} from '@fuzdev/fuz_app/testing/rpc_round_trip.js';
import {describe_data_exposure_tests} from '@fuzdev/fuz_app/testing/data_exposure.js';
import {create_role_schema} from '@fuzdev/fuz_app/auth/role_schema.js';
import type {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import {stub} from '@fuzdev/fuz_app/testing/stubs.js';

import {zzz_session_config} from '$lib/server/routes/account.js';
import {
	create_zzz_app_route_specs,
	create_zzz_rpc_endpoint_spec,
} from '$lib/server/zzz_route_specs.js';

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

/** zzz uses default admin/keeper roles — no app-specific extensions. */
const zzz_roles = create_role_schema({});

// -- Composable suites --

describe_standard_integration_tests({
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	db_factories,
});

describe_standard_admin_integration_tests({
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	roles: zzz_roles,
	db_factories,
});

describe_rate_limiting_tests({
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	db_factories,
});

describe_round_trip_validation({
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	skip_routes: [
		'GET /api/rpc', // covered by describe_rpc_round_trip_tests
		'POST /api/rpc',
	],
});

describe_rpc_round_trip_tests({
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	rpc_endpoints: [create_zzz_rpc_endpoint_spec(zzz_rpc_stub_deps)],
	// Domain handlers use a throwing stub Backend — the RPC dispatcher catches
	// all throws and returns well-formed JSON-RPC error responses, which the
	// round-trip test accepts. Only DiskfileDirectoryPath inputs need overrides
	// because the schema generator can't produce trailing-slash absolute paths.
	input_overrides: new Map([
		['workspace_open', {path: '/test/dir/'}],
		['workspace_close', {path: '/test/dir/'}],
	]),
});

describe_data_exposure_tests({
	build: create_zzz_app_surface_spec,
	session_options: zzz_session_config,
	create_route_specs: create_zzz_test_route_specs,
	db_factories,
});
