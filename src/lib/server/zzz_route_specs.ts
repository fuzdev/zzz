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
import {create_admin_account_route_specs} from '@fuzdev/fuz_app/auth/admin_routes.js';
import {create_app_settings_route_specs} from '@fuzdev/fuz_app/auth/app_settings_routes.js';
import {
	create_audit_log_route_specs,
	type AuditLogRouteOptions,
} from '@fuzdev/fuz_app/auth/audit_log_routes.js';
import {create_rpc_endpoint} from '@fuzdev/fuz_app/actions/action_rpc.js';

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
	// RPC endpoint for all zzz actions
	...prefix_route_specs(
		'/api',
		create_rpc_endpoint({
			path: '/rpc',
			actions: create_zzz_rpc_actions(zzz_deps.zzz),
			log: ctx.deps.log,
		}),
	),
	// Admin routes
	...prefix_route_specs('/api/admin', [
		...create_admin_account_route_specs(ctx.deps),
		...create_audit_log_route_specs({stream: zzz_deps.audit_sse}),
		...create_app_settings_route_specs(ctx.deps, {app_settings: ctx.app_settings}),
	]),
];

/**
 * Build the RPC endpoint spec for surface generation.
 */
export const create_zzz_rpc_endpoint_spec = (zzz_deps: ZzzRpcDeps): RpcEndpointSpec => ({
	path: '/api/rpc',
	actions: create_zzz_rpc_actions(zzz_deps),
});
