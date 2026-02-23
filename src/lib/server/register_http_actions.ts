import {Hono} from 'hono';
import {wait} from '@fuzdev/fuz_util/async.js';
import type {ContentfulStatusCode} from 'hono/utils/http-status';

import type {Backend} from './backend.js';
import {PathWithoutTrailingSlash} from '../zod_helpers.js';
import {
	create_jsonrpc_error_message_from_thrown,
	jsonrpc_error_code_to_http_status,
	to_jsonrpc_message_id,
} from '../jsonrpc_helpers.js';
import {jsonrpc_error_messages} from '../jsonrpc_errors.js';

export interface RegisterActionsOptions {
	path: string;
	app: Hono;
	backend: Backend;
	/** Artificial response delay in ms (testing). */
	artificial_delay?: number;
}

/**
 * Registers HTTP endpoints for all service actions in the schema registry.
 */
export const register_http_actions = ({
	path,
	app,
	backend,
	artificial_delay = 0,
}: RegisterActionsOptions): void => {
	const final_path = PathWithoutTrailingSlash.parse(path);

	if (artificial_delay > 0) {
		app.use('*', async (_c, next) => {
			backend.log?.debug(`[http_middleware] throttling ${artificial_delay}ms`);
			await wait(artificial_delay);
			await next();
		});
	}

	// TODO @api use `GET` when `side_effects` is falsy, encode in URL params (what format?)

	app.post(final_path, async (c) => {
		let json;
		try {
			json = await c.req.json();
		} catch (error) {
			backend.log?.error('[http] JSON parse error:', error);
			return c.json(jsonrpc_error_messages.parse_error(), 400);
		}

		try {
			const response = await backend.receive(json);
			return c.json(response);
		} catch (error) {
			backend.log?.error('[http] error processing JSON-RPC request:', error);
			const error_response = create_jsonrpc_error_message_from_thrown(
				to_jsonrpc_message_id(json),
				error,
			);
			return c.json(
				error_response,
				jsonrpc_error_code_to_http_status(error_response.error.code) as ContentfulStatusCode,
			);
		}
	});
};
