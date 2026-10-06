/**
 * The backend's byte routes for files: read a file's bytes (with `Range`),
 * create a file from bytes, and append bytes at an expected offset. Plain
 * HTTP beside the JSON-RPC endpoint, for content that isn't text or doesn't
 * fit one message.
 *
 * @module
 */

/**
 * The byte routes' path below the API path — twin of the backend's
 * `FILE_BYTES_PATH`, which the cross-backend byte-route suite pins it to.
 */
export const FILE_BYTES_SUBPATH = '/files/bytes';

/**
 * Largest body one create or append accepts, in bytes — twin of the backend's
 * `FILE_BYTES_MAX_BODY_BYTES`. A larger file is written as several appends.
 */
export const FILE_BYTES_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Body of a successful create (`201`) or append (`200`): the file's size after it. */
export interface FileBytesWritten {
	size: number;
}

/**
 * Body of a refused request. `error` is a reason like `already_exists`,
 * `offset_mismatch`, `path_not_allowed`, or `authentication_required`.
 */
export interface FileBytesError {
	error: string;
	/** The file's current size, sent with `offset_mismatch`. */
	size?: number;
}

/**
 * Builds the URL of a file's bytes. `GET` it to read (a media element can use
 * it as its `src`), `POST` to create the file from the request body.
 *
 * @param api_url - the API's URL or path, with no trailing slash
 * @param path - the file's absolute path
 */
export const to_file_bytes_url = (api_url: string, path: string): string =>
	`${api_url}${FILE_BYTES_SUBPATH}?path=${encodeURIComponent(path)}`;

/**
 * Builds the URL to `PATCH` to append to a file. The append lands only if the
 * file is exactly `offset` bytes long.
 *
 * @param api_url - the API's URL or path, with no trailing slash
 * @param path - the file's absolute path
 * @param offset - the size the file must currently have
 */
export const to_file_bytes_append_url = (api_url: string, path: string, offset: number): string =>
	`${to_file_bytes_url(api_url, path)}&offset=${offset}`;

/** The `fetch` the byte-route calls go through. */
export type FileBytesFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Outcome of a create or an append. On failure `status` is the HTTP status
 * (`0` when the request never got an answer) and `reason` the backend's
 * `error` (`network_error` or `invalid_response` when there was none).
 */
export type FileBytesWriteResult =
	{ ok: true; size: number } | { ok: false; status: number; reason: string; size?: number };

const send_file_bytes = async (
	fetch: FileBytesFetch,
	url: string,
	method: 'POST' | 'PATCH',
	body: Blob | BufferSource | null
): Promise<FileBytesWriteResult> => {
	let response: Response;
	try {
		response = await fetch(url, {
			method,
			body,
			headers: { 'content-type': 'application/octet-stream' }
		});
	} catch {
		return { ok: false, status: 0, reason: 'network_error' };
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		json = null;
	}
	const { size, error } = (json ?? {}) as { size?: unknown; error?: unknown };
	if (response.ok) {
		return typeof size === 'number'
			? { ok: true, size }
			: { ok: false, status: response.status, reason: 'invalid_response' };
	}
	return {
		ok: false,
		status: response.status,
		reason: typeof error === 'string' ? error : 'invalid_response',
		...(typeof size === 'number' ? { size } : null)
	};
};

/**
 * Creates a file from bytes, never replacing one: a taken path fails with
 * `already_exists`.
 *
 * @param fetch - the `fetch` to send with
 * @param api_url - the API's URL or path, with no trailing slash
 * @param path - the new file's absolute path
 * @param body - the file's first bytes, or `null` to create it empty
 */
export const create_file_bytes = (
	fetch: FileBytesFetch,
	api_url: string,
	path: string,
	body: Blob | BufferSource | null = null
): Promise<FileBytesWriteResult> =>
	send_file_bytes(fetch, to_file_bytes_url(api_url, path), 'POST', body);

/**
 * Appends bytes to a file, only if it is exactly `offset` bytes long.
 * Otherwise it fails with `offset_mismatch` and the file's current `size`,
 * having written nothing.
 *
 * @param fetch - the `fetch` to send with
 * @param api_url - the API's URL or path, with no trailing slash
 * @param path - the file's absolute path
 * @param offset - the size the file must currently have
 * @param body - the bytes to append
 */
export const append_file_bytes = (
	fetch: FileBytesFetch,
	api_url: string,
	path: string,
	offset: number,
	body: Blob | BufferSource
): Promise<FileBytesWriteResult> =>
	send_file_bytes(fetch, to_file_bytes_append_url(api_url, path, offset), 'PATCH', body);
