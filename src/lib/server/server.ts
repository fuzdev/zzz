/**
 * Node.js server entry point.
 *
 * Used for SvelteKit dev mode and Node.js production builds.
 * Delegates to `create_zzz_app` for the shared Hono app setup,
 * then handles Node-specific concerns: HTTP binding, WebSocket injection,
 * SvelteKit handler mounting.
 *
 * @module
 */

import {Hono} from 'hono';
import {serve, type HttpBindings} from '@hono/node-server';
import {createNodeWebSocket} from '@hono/node-ws';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {
	SECRET_ANTHROPIC_API_KEY,
	SECRET_OPENAI_API_KEY,
	SECRET_GOOGLE_API_KEY,
	ALLOWED_ORIGINS,
} from '$env/static/private';
import {DEV} from 'esm-env';

import pkg from '../../../package.json' with {type: 'json'};
import {create_zzz_app} from './create_zzz_app.js';
import {load_server_env} from './server_env.js';
import {
	API_PATH_FOR_HTTP_RPC,
	SERVER_HOST,
	SERVER_PROXIED_PORT,
	WEBSOCKET_PATH,
	ZZZ_DIR,
	ZZZ_SCOPED_DIRS,
	BACKEND_ARTIFICIAL_RESPONSE_DELAY,
} from '../constants.js';

const log = new Logger('[server]');

const create_server = async (): Promise<void> => {
	// Load env — in Node/SvelteKit mode, we use the $env values that are
	// already parsed in constants.ts, passed as defaults.
	const env = load_server_env((key) => process.env[key], {
		zzz_dir: ZZZ_DIR,
		scoped_dirs: ZZZ_SCOPED_DIRS,
		port: SERVER_PROXIED_PORT,
		host: SERVER_HOST,
		allowed_origins: ALLOWED_ORIGINS,
		websocket_path: WEBSOCKET_PATH,
		api_path: API_PATH_FOR_HTTP_RPC,
		artificial_delay: BACKEND_ARTIFICIAL_RESPONSE_DELAY,
		app_version: pkg.version,
		secret_anthropic_api_key: SECRET_ANTHROPIC_API_KEY || undefined,
		secret_openai_api_key: SECRET_OPENAI_API_KEY || undefined,
		secret_google_api_key: SECRET_GOOGLE_API_KEY || undefined,
	});

	// Node WebSocket adapter — needs a temporary Hono app for setup,
	// then the real app is created by the factory.
	const {injectWebSocket, upgradeWebSocket} = createNodeWebSocket({app: new Hono()});

	// Create the shared zzz app
	const {app, backend} = create_zzz_app({env, upgradeWebSocket});

	// In production with the Node adapter, mount the SvelteKit handler to serve the frontend.
	if (!DEV) {
		try {
			// Dynamically import the handler from the SvelteKit build output.

			// TODO we don't want the path statically analyzed and bundled so the path is constructed --
			// instead this should probably be configured as an external in the Gro server plugin
			const handler_path = '../../' + 'build/handler.js'; // eslint-disable-line no-useless-concat

			const {handler} = await import(handler_path);

			// Let SvelteKit handle everything else, including serving prerendered pages and static assets.
			// Pass Node.js native request/response objects to the SvelteKit handler.

			// TODO this casting is hacky, declaring the `hono` instance above like this causes
			// the HttpBindings type to propagate to other interfaces, which I don't want right now
			(app as unknown as Hono<{Bindings: HttpBindings}>).use('*', async (c) => {
				await handler(c.env.incoming, c.env.outgoing);
				// The handler writes directly to c.env.outgoing, so return a Response with
				// the x-hono-already-sent header to tell Hono not to process the response.
				return new Response(null, {headers: {'x-hono-already-sent': 'true'}});
			});
		} catch (error) {
			log.error(
				'failed to load SvelteKit handler -- was the Node adapter correctly used with `ZZZ_BUILD=node gro build`?',
				error,
			);
			throw error;
		}
	}

	const hono = serve(
		{
			hostname: env.host,
			port: env.port,
			fetch: app.fetch,
		},
		(info) => {
			log.info(`listening on http://${info.address}:${info.port}`);
		},
	);

	injectWebSocket(hono);

	const shutdown = async (signal: string): Promise<void> => {
		log.info(`received ${signal}, shutting down...`);
		await backend.destroy();
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void create_server().catch((error) => {
	log.error('error starting server:', error);
	throw error;
});
