/**
 * Shared zzz route spec factory.
 *
 * Used by the production server, integration tests, and attack surface helpers.
 * Does NOT include bootstrap routes (factory-managed by `create_app_server`).
 *
 * @module
 */

import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import {prefix_route_specs, type RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import type {RpcEndpointSpec} from '@fuzdev/fuz_app/http/surface.js';
import {
	create_health_route_spec,
	create_server_status_route_spec,
} from '@fuzdev/fuz_app/http/common_routes.js';
import {
	create_account_status_route_spec,
	create_account_route_specs,
} from '@fuzdev/fuz_app/auth/account_routes.js';
import {
	create_audit_log_route_specs,
	type AuditLogRouteOptions,
} from '@fuzdev/fuz_app/auth/audit_log_routes.js';
import {create_standard_rpc_actions} from '@fuzdev/fuz_app/auth/standard_rpc_actions.js';

import {create_zzz_rpc_actions, type ZzzRpcDeps} from './zzz_rpc_actions.js';

/** zzz-specific deps not available in AppServerContext. */
export interface ZzzAppRouteDeps {
	zzz: ZzzRpcDeps;
	version: string;
	get_uptime_ms: () => number;
	/** Audit log SSE stream config. */
	audit_sse?: AuditLogRouteOptions['stream'];
}

/**
 * Build all zzz route specs.
 *
 * Used by production server, integration tests, and attack surface helpers.
 * Does NOT include bootstrap routes (those are factory-managed by `create_app_server`).
 *
 * Does NOT include the `/api/rpc` endpoint — `create_app_server` auto-mounts
 * every `RpcEndpointSpec` passed via `rpc_endpoints`. Consumers supply that
 * endpoint spec through `build_rpc_endpoint_specs` below.
 */
export const create_zzz_app_route_specs = (
	ctx: AppServerContext,
	zzz_deps: ZzzAppRouteDeps,
): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options: ctx.session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
		}),
	),
	create_account_status_route_spec({bootstrap_status: ctx.bootstrap_status}),
	create_server_status_route_spec({
		version: zzz_deps.version,
		get_uptime_ms: zzz_deps.get_uptime_ms,
	}),
	// Audit log SSE stream (the remaining admin REST — reads + mutations moved to RPC).
	...prefix_route_specs('/api/admin', create_audit_log_route_specs({stream: zzz_deps.audit_sse})),
];

/**
 * Build the `/api/rpc` endpoint spec(s) for `create_app_server`.
 *
 * Pass to `rpc_endpoints` as a factory — closes over `ctx.deps` +
 * `ctx.app_settings` for the standard admin + permit-offer + account
 * action set. `create_app_server` auto-mounts each entry via
 * `create_rpc_endpoint`.
 */
export const build_rpc_endpoint_specs = (
	ctx: AppServerContext,
	zzz_deps: ZzzRpcDeps,
): Array<RpcEndpointSpec> => [
	{
		path: '/api/rpc',
		actions: [
			...create_zzz_rpc_actions(zzz_deps),
			...create_standard_rpc_actions(ctx.deps, {app_settings: ctx.app_settings}),
		],
	},
];
