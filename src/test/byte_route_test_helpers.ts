import type { FileBytesFetch } from '$lib/file_bytes.ts';

/** One request a `FakeByteRoutes` received. */
export interface FakeByteRequest {
	method: string;
	path: string;
	offset: number | null;
	size: number;
}

/** What a `FakeByteRoutes` answers a request with instead of handling it. */
export type FakeByteReply =
	| 'network_error'
	| { status: number; body: unknown }
	/** Applies the request, then loses the reply — as if the connection dropped after it. */
	| 'lose_reply';

/**
 * An in-memory stand-in for the backend's byte routes: `fetch` creates and
 * appends to `files` with the routes' statuses and bodies. `replies` are
 * consumed first, one per request, to inject failures.
 */
export class FakeByteRoutes {
	readonly files: Map<string, Array<Blob>> = new Map();
	readonly requests: Array<FakeByteRequest> = [];
	readonly replies: Array<FakeByteReply> = [];

	size_of(path: string): number {
		return (this.files.get(path) ?? []).reduce((sum, chunk) => sum + chunk.size, 0);
	}

	readonly fetch: FileBytesFetch = (input, init) => {
		const url = new URL(input, 'http://zzz.test');
		const path = url.searchParams.get('path')!;
		const raw_offset = url.searchParams.get('offset');
		const offset = raw_offset === null ? null : Number(raw_offset);
		const method = init?.method ?? 'GET';
		const body = init?.body == null ? new Blob([]) : (init.body as Blob);
		this.requests.push({ method, path, offset, size: body.size });

		const injected = this.replies.shift();
		if (injected === 'network_error') return Promise.reject(new TypeError('fetch failed'));
		if (injected !== undefined && injected !== 'lose_reply') {
			return Promise.resolve(to_response(injected.status, injected.body));
		}

		const reply = this.#handle(method, path, offset, body);
		if (injected === 'lose_reply') return Promise.reject(new TypeError('fetch failed'));
		return Promise.resolve(reply);
	};

	#handle(method: string, path: string, offset: number | null, body: Blob): Response {
		const chunks = this.files.get(path);
		if (method === 'POST') {
			if (chunks) return to_response(409, { error: 'already_exists' });
			this.files.set(path, body.size ? [body] : []);
			return to_response(201, { size: body.size });
		}
		if (method === 'PATCH') {
			if (!chunks) return to_response(404, { error: 'path_not_found' });
			const size = this.size_of(path);
			if (offset !== size) return to_response(409, { error: 'offset_mismatch', size });
			chunks.push(body);
			return to_response(200, { size: size + body.size });
		}
		return to_response(405, { error: 'method_not_allowed' });
	}
}

const to_response = (status: number, body: unknown): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	}) as Response;

/** A blob of `size` bytes. */
export const blob_of = (size: number): Blob => new Blob([new Uint8Array(size)]);
