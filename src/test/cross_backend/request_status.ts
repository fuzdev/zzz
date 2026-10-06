/**
 * A request helper for bodies the server may refuse from the headers alone.
 *
 * @module
 */

import { request as http_request } from 'node:http';

/**
 * Send `body` and resolve the response status, for a request the server may
 * refuse by its headers alone (413 for an oversized `Content-Length`). Sends
 * `Expect: 100-continue` and writes the body only once the server asks for it
 * (`'continue'`), so a server that answers from the headers and closes never
 * races the upload into `EPIPE` / `ECONNRESET` — `fetch` has no such mode. If
 * no interim answer comes within `continue_timeout_ms`, the body is sent
 * anyway (RFC 9110 § 10.1.1). A write error after the response arrived is
 * tolerated.
 */
export const request_status = (
	url: string,
	headers: Record<string, string>,
	body: string | Uint8Array,
	method: 'POST' | 'PATCH' = 'POST',
	continue_timeout_ms = 3_000
): Promise<number> =>
	new Promise((resolve, reject) => {
		let status: number | undefined;
		let body_sent = false;
		const send_body = (): void => {
			if (body_sent || status !== undefined) return;
			body_sent = true;
			clearTimeout(continue_timer);
			req.end(body);
		};
		const req = http_request(
			url,
			{
				method,
				headers: {
					...headers,
					'Content-Length': String(Buffer.byteLength(body)),
					Expect: '100-continue'
				}
			},
			(res) => {
				status = res.statusCode;
				clearTimeout(continue_timer);
				res.on('error', () => undefined);
				res.resume();
				res.on('end', () => {
					resolve(status!);
					// an unsent body leaves the request open — drop the connection
					if (!body_sent) req.destroy();
				});
			}
		);
		const continue_timer = setTimeout(send_body, continue_timeout_ms);
		req.on('continue', send_body);
		// a write racing the server's close fails on the socket too
		req.on('socket', (socket) => socket.on('error', () => undefined));
		req.on('error', (error) => {
			clearTimeout(continue_timer);
			if (status === undefined) reject(error);
			else resolve(status);
		});
		req.flushHeaders();
	});
