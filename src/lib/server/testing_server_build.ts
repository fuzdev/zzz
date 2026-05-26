/**
 * zzz domain seams for the cross-process test binary.
 *
 * The runtime-neutral orchestration (serve, daemon-info, WS attach, drain)
 * + the Node/Deno adapters now live in fuz_app
 * (`@fuzdev/fuz_app/testing/cross_backend/testing_server_{core,node,deno}.js`).
 * This module keeps only what's zzz-specific: env loading + the
 * `create_zzz_app` build with `_testing_reset` + the domain `reset_state`
 * closure + WS registration.
 *
 * **NEVER ship in a release.** Reaches into fuz_app's `testing/cross_backend/`
 * modules which throw on production-bundle load.
 *
 * @module
 */

import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {Logger} from '@fuzdev/fuz_util/log.js';
import type {Context} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';
import {stub_password_deps} from '@fuzdev/fuz_app/testing/app_server.js';
import {create_testing_actions} from '@fuzdev/fuz_app/testing/cross_backend/testing_reset_actions.js';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.js';
import type {RuntimeDeps} from '@fuzdev/fuz_app/runtime/deps.js';
import type {BuiltTestingApp} from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env, type ZzzServerConfig} from './server_env.ts';
import {register_websocket_actions} from './register_websocket_actions.ts';
import {ENV_FILE} from './constants.ts';

const log = new Logger('[testing_server]');

export interface ResolvedZzzTestingConfig {
	config: ZzzServerConfig;
	daemon_token_path: string;
	scratch_dir: string | undefined;
}

/**
 * Load the env file (non-overriding), default `PUBLIC_ZZZ_DIR`, and build the
 * forced-test-actions config. Mutates `runtime` env. Returns the config plus
 * the derived daemon-token path + optional scratch dir.
 */
export const resolve_zzz_testing_config = async (
	runtime: RuntimeDeps,
): Promise<ResolvedZzzTestingConfig> => {
	const dotenv = await load_env_file(runtime, ENV_FILE);
	if (dotenv) {
		for (const [key, value] of Object.entries(dotenv)) {
			if (runtime.env_get(key) === undefined) runtime.env_set(key, value);
		}
	}
	if (runtime.env_get('PUBLIC_ZZZ_DIR') === undefined) {
		runtime.env_set('PUBLIC_ZZZ_DIR', `${runtime.env_get('HOME') ?? '.'}/.zzz`);
	}
	const config = load_server_env((key) => runtime.env_get(key), {
		app_version: VERSION,
		enable_test_actions: true,
	});
	const zzz_dir = runtime.env_get('PUBLIC_ZZZ_DIR')!;
	return {
		config,
		daemon_token_path: `${zzz_dir}/run/daemon_token`,
		scratch_dir: runtime.env_get('ZZZ_TESTING_SCRATCH_DIR'),
	};
};

export interface BuildZzzTestingAppOptions {
	config: ZzzServerConfig;
	runtime: RuntimeDeps;
	get_connection_ip: (c: Context) => string | undefined;
	daemon_token_path: string;
	scratch_dir: string | undefined;
}

/** Build the zzz test app: `create_zzz_app` + `_testing_reset` + WS mount hook. */
export const build_zzz_testing_app = async (
	options: BuildZzzTestingAppOptions,
): Promise<BuiltTestingApp> => {
	const {config, runtime, get_connection_ip, daemon_token_path, scratch_dir} = options;

	const {app, backend, app_backend, allowed_origins, extra_ws_actions, close} =
		await create_zzz_app({
			config,
			password: stub_password_deps,
			runtime,
			get_connection_ip,
			daemon_token_path,
			disable_rate_limiters: true,
			extra_rpc_actions_factory: (deps, zzz_backend, {daemon_token_state, session_options}) => {
				if (!daemon_token_state) {
					throw new Error(
						'testing_server requires daemon-token rotation (it provides keeper credentials for _testing_reset)',
					);
				}
				return create_testing_actions(deps, {
					session_options,
					daemon_token_state,
					reset_state: async () => {
						for (const path of [...zzz_backend.workspaces.keys()]) {
							await zzz_backend.workspace_close(path);
						}
						await zzz_backend.pty_manager.kill_all();
						if (scratch_dir && existsSync(scratch_dir)) {
							await rm(scratch_dir, {recursive: true, force: true});
						}
					},
				});
			},
		});

	// fuz_app's core shutdown calls `close` only; zzz also destroys its domain
	// Backend, so wrap.
	const wrapped_close = async (): Promise<void> => {
		await backend.destroy();
		await close();
	};

	const mount_websocket = config.websocket_path
		? (upgrade_websocket: UpgradeWebSocket): void => {
				const transport = new BackendWebsocketTransport();
				register_websocket_actions({
					path: config.websocket_path,
					app,
					backend,
					db: app_backend.deps.db,
					upgradeWebSocket: upgrade_websocket,
					allowed_origins,
					artificial_delay: config.artificial_delay,
					transport,
					extra_actions: extra_ws_actions,
				});
				app_backend.deps.audit.on_event_chain.push(
					create_ws_auth_guard(transport, log),
					create_ws_logout_closer(transport, log),
				);
			}
		: undefined;

	return {app, close: wrapped_close, mount_websocket};
};
