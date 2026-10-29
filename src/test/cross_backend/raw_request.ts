/**
 * A request helper that sends exactly the headers it's given.
 *
 * @module
 */

import { request as http_request, type IncomingMessage } from 'node:http';

export interface RawResponse {
	status: number;
	body: string;
}

/**
 * Send one request exactly as given and read the reply. Goes through
 * `node:http`, since `fetch` won't send a chosen `Host` — a `host` header here
 * replaces the one the URL would give.
 *
 * A completed WebSocket upgrade resolves with its `101` and an empty body, the
 * socket destroyed.
 */
export const raw_request = (
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> =>
	new Promise((resolve, reject) => {
		const req = http_request(url, {
			method: options.method ?? 'GET',
			headers: options.headers
		});
		const on_response = (res: IncomingMessage): void => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode!, body }));
		};
		req.on('response', on_response);
		// a 101 would mean the gates let an upgrade through
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve({ status: res.statusCode!, body: '' });
		});
		req.on('error', reject);
		req.end(options.body);
	});
