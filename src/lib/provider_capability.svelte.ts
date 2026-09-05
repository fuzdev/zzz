import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import type { JsonrpcRequestId } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import type { Frontend } from './frontend.svelte.ts';
import type { Capability } from './capabilities.svelte.ts';
import type { ProviderName, ProviderStatus } from './provider_types.ts';

export interface ProviderCapabilityOptions {
	app: Frontend;
	name: ProviderName;
}

/**
 * Per-provider availability capability, derived from the backend's
 * `provider_status`. Plain reactive class — not a Cell: it has no
 * persisted state, everything is `$derived` from
 * `app.lookup_provider_status(name)`. One instance per `ProviderName`
 * lives in `Capabilities.providers`, collapsing what were three
 * hand-rolled claude/chatgpt/gemini `$derived` blocks plus their
 * `init_*_check`/`check_*` pairs into a single keyed shape.
 */
export class ProviderCapability implements Capability<null | undefined> {
	readonly app: Frontend;
	readonly name: ProviderName;
	readonly message_id: JsonrpcRequestId | null = null;

	// `$derived.by` (not bare `$derived`) so the `this.app`/`this.name` reads
	// sit inside a closure: field initializers run before the constructor
	// body assigns them, and TS flags an eager read as use-before-init.
	/** Latest backend status for this provider, or `null` if never checked. */
	readonly #status: ProviderStatus | null = $derived.by(() =>
		this.app.lookup_provider_status(this.name)
	);

	readonly status: AsyncStatus = $derived(
		!this.#status ? 'initial' : this.#status.available ? 'success' : 'failure'
	);
	/** `null` available, `undefined` unknown — matches the `Capability` data contract. */
	readonly data: null | undefined = $derived(this.#status?.available ? null : undefined);
	readonly error_message: string | null = $derived(
		this.#status && !this.#status.available ? this.#status.error : null
	);
	readonly updated: number | null = $derived(this.#status?.checked_at ?? null);

	constructor(options: ProviderCapabilityOptions) {
		this.app = options.app;
		this.name = options.name;
	}

	/**
	 * Check availability only if it hasn't been checked before
	 * (when status is `'initial'`).
	 */
	async init_check(): Promise<void> {
		if (this.status !== 'initial') return;
		await this.check();
	}

	/** Check availability by loading provider status from the backend. */
	async check(): Promise<void> {
		if (!this.app.capabilities.backend_available) {
			console.log(`[capabilities] skipping ${this.name} check: backend unavailable`);
			return;
		}
		await this.app.api.provider_load_status({ provider_name: this.name });
	}
}
