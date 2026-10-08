/**
 * Uploads a file as a sequence of chunks through the backend's byte routes,
 * one at a time and in order, as they're produced.
 *
 * @module
 */

import { wait } from '@fuzdev/fuz_util/async.ts';

import { append_file_bytes, create_file_bytes, type FileBytesFetch } from './file_bytes.ts';

/** Waits between attempts of one chunk; a chunk fails once these run out. */
export const CHUNK_UPLOAD_RETRY_DELAYS: ReadonlyArray<number> = [500, 1000, 2000, 4000];

export interface ChunkUploadOptions {
	fetch: FileBytesFetch;
	/** The API's URL or path, with no trailing slash. */
	api_url: string;
	/** The absolute path of the file to create and append to. */
	path: string;
	/** Called with the file's size each time a chunk lands. */
	on_progress?: (uploaded_bytes: number) => void;
	/** Called once, when a chunk fails for good. Nothing is uploaded after. */
	on_error?: (message: string) => void;
	/** Waits between attempts of one chunk (default `CHUNK_UPLOAD_RETRY_DELAYS`). */
	retry_delays?: ReadonlyArray<number>;
	/** Waits `ms` (default `wait`). */
	sleep?: (ms: number) => Promise<unknown>;
}

/**
 * One file's upload. `create` makes the file, `enqueue` appends each chunk
 * after the ones before it, and `flush` waits for everything queued.
 *
 * Each chunk is appended at the offset the upload expects, so one can never
 * land twice or out of order. A request that gets no answer or a server error
 * is retried; when the retry finds the file already grew by exactly this
 * chunk, the earlier attempt landed and the chunk is done. Any other refusal
 * — the file changed underneath, the session ended — fails the upload.
 */
export class ChunkUpload {
	readonly path: string;

	/** The file's size as the backend last confirmed it. */
	uploaded_bytes = 0;

	/** Why the upload failed, once it has. */
	error: string | null = null;

	readonly #options: ChunkUploadOptions;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: ChunkUploadOptions) {
		this.#options = options;
		this.path = options.path;
	}

	/**
	 * Creates the file, empty. Call it once, before any `enqueue`.
	 *
	 * @throws Error when the file can't be created — `already exists` for a taken path
	 */
	async create(): Promise<void> {
		const { fetch, api_url, path } = this.#options;
		const result = await create_file_bytes(fetch, api_url, path);
		if (!result.ok) {
			throw new Error(result.reason === 'already_exists' ? 'already exists' : result.reason);
		}
		this.uploaded_bytes = result.size;
	}

	/**
	 * Queues a chunk to append after every chunk queued before it. Chunks
	 * queued after the upload failed are dropped.
	 */
	enqueue(chunk: Blob): void {
		this.#queue = this.#queue.then(() => this.#append(chunk));
	}

	/**
	 * Waits for every queued chunk.
	 *
	 * @throws Error with the failure when the upload failed
	 */
	async flush(): Promise<void> {
		await this.#queue;
		if (this.error !== null) throw new Error(this.error);
	}

	async #append(chunk: Blob): Promise<void> {
		if (this.error !== null || chunk.size === 0) return;
		const { fetch, api_url, path, on_progress, on_error } = this.#options;
		const retry_delays = this.#options.retry_delays ?? CHUNK_UPLOAD_RETRY_DELAYS;
		const sleep = this.#options.sleep ?? wait;
		const offset = this.uploaded_bytes;

		for (let attempt = 0; ; attempt++) {
			const result = await append_file_bytes(fetch, api_url, path, offset, chunk);
			if (result.ok) {
				this.uploaded_bytes = result.size;
				on_progress?.(result.size);
				return;
			}
			if (result.reason === 'offset_mismatch' && result.size === offset + chunk.size) {
				// an earlier attempt landed and only its reply was lost
				this.uploaded_bytes = result.size;
				on_progress?.(result.size);
				return;
			}
			const retryable = result.status === 0 || result.status >= 500;
			const delay = retry_delays[attempt];
			if (!retryable || delay === undefined) {
				this.error =
					result.reason === 'offset_mismatch'
						? 'the file changed on disk while it was being written'
						: result.reason;
				on_error?.(this.error);
				return;
			}
			await sleep(delay);
		}
	}
}
