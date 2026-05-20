/**
 * Audit log completeness tests — wires fuz_app's composable suite
 * against zzz's standard admin RPC bundle.
 *
 * Verifies that every auth mutation route produces the expected audit
 * log event. zzz mounts the full `create_standard_rpc_actions` bundle
 * (admin + role_grant_offer + account) via `build_rpc_endpoint_specs`,
 * so the suite has live `role_grant_offer_*`, `admin_session_revoke_all`,
 * `admin_token_revoke_all`, `app_settings_update`, `invite_*`, and
 * `audit_log_list` methods to drive.
 *
 * @module
 */

import {describe_audit_completeness_tests} from '@fuzdev/fuz_app/testing/audit_completeness.js';
import {default_in_process_suite_options} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';
import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import type {RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import {stub} from '@fuzdev/fuz_app/testing/stubs.js';
import {fuz_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';

import {create_zzz_app_route_specs, build_rpc_endpoint_specs} from '$lib/server/zzz_route_specs.js';

/** Stub deps — domain handlers are never called by audit completeness tests. */
const zzz_rpc_stub_deps = {
	backend: stub,
};

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> =>
	create_zzz_app_route_specs(ctx, {
		zzz: zzz_rpc_stub_deps,
		version: '',
		get_uptime_ms: () => 0,
	});

const rpc_endpoints = (ctx: AppServerContext) => build_rpc_endpoint_specs(ctx, zzz_rpc_stub_deps);

describe_audit_completeness_tests(
	default_in_process_suite_options({
		session_options: fuz_session_config,
		create_route_specs,
		rpc_endpoints,
		extra_keeper_roles: [ROLE_ADMIN],
		// Mirror production wiring (`create_zzz_app.ts`) — synthetic
		// `token_path` since the test keeper bootstrap flips
		// `bootstrap_lock`, making this 403 `ALREADY_BOOTSTRAPPED`
		// regardless of token presence.
		bootstrap: {mode: 'live', token_path: '/test/bootstrap.token'},
	}),
);
