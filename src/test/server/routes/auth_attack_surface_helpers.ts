/**
 * Attack surface helpers for zzz.
 *
 * Provides the shared `create_zzz_app_surface_spec` factory and fixture
 * path resolver used by attack surface tests and snapshot generation.
 *
 * @module
 */

import {create_test_app_surface_spec, stub, stub_mw} from '@fuzdev/fuz_app/testing/stubs.js';
import {resolve_fixture_path} from '@fuzdev/fuz_app/testing/assertions.js';
import type {AppSurfaceSpec} from '@fuzdev/fuz_app/http/surface.js';
import type {MiddlewareSpec} from '@fuzdev/fuz_app/http/middleware_spec.js';

import {zzz_session_config} from '$lib/server/routes/account.js';
import {create_zzz_app_route_specs, build_rpc_endpoint_specs} from '$lib/server/zzz_route_specs.js';
import {ZzzServerEnv} from '$lib/server/server_env.js';

/** Stub deps for zzz RPC actions — handlers are never called during surface generation. */
const zzz_stub_deps = {
	backend: stub,
};

/**
 * Create the zzz attack surface spec for snapshot and adversarial testing.
 *
 * Mirrors production assembly: route specs + host_validation middleware +
 * RPC endpoint with zzz domain actions plus the standard admin bundle.
 */
export const create_zzz_app_surface_spec = (): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: zzz_session_config,
		create_route_specs: (ctx) =>
			create_zzz_app_route_specs(ctx, {
				zzz: zzz_stub_deps,
				version: '',
				get_uptime_ms: () => 0,
			}),
		rpc_endpoints: (ctx) => build_rpc_endpoint_specs(ctx, zzz_stub_deps),
		env_schema: ZzzServerEnv,
		transform_middleware: (specs: Array<MiddlewareSpec>): Array<MiddlewareSpec> => [
			{name: 'host_validation', path: '*', handler: stub_mw},
			...specs,
		],
	});

/** Resolve fixture paths relative to this module. */
export const resolve_zzz_fixture_path = (filename: string): string =>
	resolve_fixture_path(filename, import.meta.url);
