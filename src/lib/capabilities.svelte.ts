// @slop Claude Sonnet 3.7

import {z} from 'zod';
import type {AsyncStatus} from '@fuzdev/fuz_util/async.ts';
import type {JsonrpcRequestId} from '@fuzdev/fuz_app/http/jsonrpc.ts';

import {Cell, type CellOptions} from './cell.svelte.ts';
import {CellJson} from './cell_types.ts';
import type {DiskfileDirectoryPath} from './diskfile_types.ts';
import {ProviderCapability} from './provider_capability.svelte.ts';
import type {ProviderName} from './provider_types.ts';

// TODO namerbot capability, uses backend+(at least one provider) (or rethink its role in a bigger picture, not just names)

// TODO extract reusable stuff to make this generic

/** Maximum number of ping records to keep. */
export const PING_HISTORY_MAX = 6;

export const CapabilitiesJson = CellJson.extend({}).meta({cell_class_name: 'Capabilities'});
export type CapabilitiesJson = z.infer<typeof CapabilitiesJson>;
export type CapabilitiesJsonInput = z.input<typeof CapabilitiesJson>;

/**
 * Generic interface for a capability with standardized status tracking.
 */
export interface Capability<T> {
	/** The capability name. */
	name: string;
	/** The capability's status: undefined=not initialized, null=checking, otherwise available or not. */
	data: T;
	/** Async status tracking the connection/check state. */
	status: AsyncStatus;
	// TODO maybe rename to `request_id` as it's used elsewhere?
	/** Message id of the last request for this capability's info, if any. */
	message_id: JsonrpcRequestId | null;
	/** Error message if any. */
	error_message: string | null;
	/** Timestamp when the capability was last checked. */
	updated: number | null;
}

export interface PingData {
	ping_id: JsonrpcRequestId;
	completed: boolean;
	sent_time: number;
	received_time: number | null;
	round_trip_time: number | null;
}

export interface ServerCapabilityData {
	// TODO think about a special endpoint that isn't `ping` with more info, maybe in .well-known as a json file - server.json?
	// name: string;
	// version: string;
	round_trip_time: number;
}

export interface WebsocketCapabilityData {
	url: string | null;
	connected: boolean;
	reconnect_count: number;
	last_connect_time: number | null;
	last_send_time: number | null;
	last_receive_time: number | null;
	connection_duration: number | null;
	pending_pings: number;
}

export interface FilesystemCapabilityData {
	zzz_dir: DiskfileDirectoryPath | null | undefined;
	scoped_dirs: ReadonlyArray<DiskfileDirectoryPath>;
}

/**
 * A class that encapsulates system capabilities detection and management.
 * This is NOT generic or extensible - it contains hardcoded logic for
 * all capabilities the system supports.
 */
export class Capabilities extends Cell<typeof CapabilitiesJson> {
	backend: Capability<ServerCapabilityData | null | undefined> = $state.raw({
		name: 'backend',
		data: undefined,
		status: 'initial',
		message_id: null,
		error_message: null,
		updated: null,
	});

	/**
	 * WebSocket capability that derives its state from the socket.
	 */
	readonly websocket: Capability<WebsocketCapabilityData | null | undefined> = $derived.by(() => {
		// Map socket status to capability status, but consider connection state
		const {socket} = this.app;
		const {status} = socket;

		// Socket is available if we're connected,
		// otherwise it's not available but we have data about its state
		const data =
			status === 'initial'
				? undefined
				: {
						url: socket.url,
						connected: socket.connected,
						reconnect_count: socket.reconnect_count,
						last_connect_time: socket.last_connect_time,
						last_send_time: socket.last_send_time,
						last_receive_time: socket.last_receive_time,
						connection_duration: socket.connection_duration,
						pending_pings: this.pending_ping_count, // Update to use new count
					};

		return {
			name: 'websocket',
			data,
			status,
			message_id: null,
			error_message: null, // Socket doesn't expose error messages directly
			updated: data?.last_connect_time ?? null,
		};
	});

	/**
	 * The filesystem capability derives its state from the backend and `zzz_dir`.
	 */
	readonly filesystem: Capability<FilesystemCapabilityData | null | undefined> = $derived.by(() => {
		const {zzz_dir, scoped_dirs} = this.app;
		let status: AsyncStatus;

		if (this.backend.status !== 'success') {
			// Server is not available, so mirror its status
			status = this.backend.status;
		} else {
			// TODO hacky, should be explicit
			if (zzz_dir === undefined) {
				status = 'initial';
			} else if (zzz_dir === null) {
				status = 'pending';
			} else if (zzz_dir === '') {
				status = 'failure';
			} else {
				status = 'success';
			}
		}

		return {
			name: 'filesystem',
			data: status === 'success' ? {zzz_dir, scoped_dirs} : undefined,
			status,
			message_id: null,
			error_message: null,
			updated: Date.now(),
		};
	});

	/**
	 * Per-provider availability capabilities, keyed by `ProviderName`.
	 * Each derives its state from `provider_status`; see `ProviderCapability`.
	 */
	readonly providers: Record<ProviderName, ProviderCapability>;

	/**
	 * Store pings - both pending and completed.
	 */
	pings: Array<PingData> = $state([]);

	/**
	 * Most recent completed ping round trip time in milliseconds.
	 */
	readonly latest_ping_time: number | null = $derived(
		this.pings.find((p) => p.completed)?.round_trip_time ?? null,
	);

	/**
	 * Completed pings (for display).
	 */
	readonly completed_pings: Array<PingData> = $derived(this.pings.filter((p) => p.completed));

	/**
	 * Number of pending pings.
	 */
	readonly pending_ping_count: number = $derived(this.pings.filter((p) => !p.completed).length);

	/**
	 * Has pending pings.
	 */
	readonly has_pending_pings: boolean = $derived(this.pending_ping_count > 0);

	/**
	 * Convenience accessor for backend availability.
	 * `undefined` means uninitialized, `null` means loading/checking.
	 * boolean indicates if available.
	 */
	readonly backend_available: boolean | null | undefined = $derived(
		this.backend.data === undefined
			? undefined
			: this.backend.status === 'pending'
				? null
				: this.backend.status === 'success' && this.backend.data !== null,
	);

	/**
	 * Convenience accessor for websocket availability.
	 * `undefined` means uninitialized, `null` means loading/checking.
	 * boolean indicates if the socket is actively connected.
	 */
	readonly websocket_available: boolean | null | undefined = $derived(
		this.websocket.data === undefined
			? undefined
			: this.websocket.status === 'pending'
				? null
				: this.websocket.status === 'success',
	);

	/**
	 * Convenience accessor for filesystem availability.
	 * `undefined` means uninitialized, `null` means loading/checking.
	 * boolean indicates if filesystem is available.
	 */
	readonly filesystem_available: boolean | null | undefined = $derived(
		this.filesystem.status === 'initial'
			? undefined
			: this.filesystem.status === 'pending'
				? null
				: this.filesystem.status === 'success',
	);

	constructor(options: CellOptions<typeof CapabilitiesJson>) {
		super(CapabilitiesJson, options);
		this.providers = {
			claude: new ProviderCapability({app: this.app, name: 'claude'}),
			chatgpt: new ProviderCapability({app: this.app, name: 'chatgpt'}),
			gemini: new ProviderCapability({app: this.app, name: 'gemini'}),
		};
	}

	/**
	 * Check backend availability only if it hasn't been checked before.
	 * (when status is 'initial')
	 */
	async init_backend_check(): Promise<void> {
		if (this.backend.status !== 'initial') {
			return;
		}
		await this.check_backend();
	}

	/**
	 * Check backend availability with a ping.
	 */
	async check_backend(): Promise<void> {
		await this.app.api.ping();
	}

	// TODO refactor maybe to a `Pings` class
	handle_ping_sent(request_id: JsonrpcRequestId): void {
		console.log(`[capabilities] [handle_ping_sent] request_id`, request_id);
		// Create a new pending ping
		const new_ping: PingData = {
			ping_id: request_id,
			completed: false,
			sent_time: Date.now(),
			received_time: null,
			round_trip_time: null,
		};

		// Add the new ping to the start of the array
		this.pings = [new_ping, ...this.pings.slice(0, PING_HISTORY_MAX - 1)];

		// TODO @many maybe refactor to middleware or more sophisticated hooks? is spread across 3 methods called from 2 mutations
		// Reset the backend state only if it hasn't connected yet, to avoid flickering
		this.backend = {
			name: 'backend',
			data: null,
			status: 'pending',
			message_id: request_id,
			error_message: null,
			updated: Date.now(),
		};
	}

	// TODO @many refactor mutations
	handle_ping_received(ping_id: JsonrpcRequestId): void {
		console.log(`[capabilities] [handle_ping_received] ping_id`, ping_id);
		const ping = this.pings.find((p) => p.ping_id === ping_id);
		// If we can't find the ping, we can safely ignore it
		if (!ping) {
			return;
		}

		const received_time = Date.now();

		ping.completed = true;
		ping.received_time = received_time;
		ping.round_trip_time = received_time - ping.sent_time;

		// TODO @many maybe refactor to middleware or more sophisticated hooks? is spread across 3 methods called from 2 mutations
		if (this.backend.message_id === ping_id) {
			this.backend = {
				name: 'backend',
				data: {
					round_trip_time: ping.round_trip_time,
				},
				status: 'success',
				message_id: ping_id,
				error_message: null,
				updated: Date.now(),
			};
		}
	}

	handle_ping_error(ping_id: JsonrpcRequestId, error_message: string): void {
		console.error(`[capabilities] [handle_ping_error] ping_id`, ping_id, error_message);

		// Mark the ping as completed (failed)
		const ping = this.pings.find((p) => p.ping_id === ping_id);
		if (ping) {
			ping.completed = true;
			ping.received_time = Date.now();
			ping.round_trip_time = null; // null indicates failure
		}

		// TODO @many maybe refactor to middleware or more sophisticated hooks? is spread across 3 methods called from 2 mutations
		if (this.backend.message_id === ping_id) {
			this.backend = {
				name: 'backend',
				data: null,
				status: 'failure',
				message_id: ping_id,
				error_message,
				updated: Date.now(),
			};
		}
	}

	/**
	 * Reset just the backend capability to uninitialized state.
	 */
	reset_backend(): void {
		this.backend = {
			name: 'backend',
			data: undefined,
			status: 'initial',
			message_id: null,
			error_message: null,
			updated: null,
		};
	}
}
