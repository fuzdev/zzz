import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { ERROR_PAYLOAD_TOO_LARGE } from '@fuzdev/fuz_app/http/error_schemas.ts';
import { format_bytes } from '@fuzdev/fuz_util/bytes.ts';

/**
 * Largest JSON-RPC message the backend accepts, in bytes of its UTF-8 JSON
 * encoding — the `/api/rpc` request-body cap and the `/api/ws` message cap
 * (16 MiB on both). Twin of the backend's `RPC_MESSAGE_MAX_BYTES` in
 * `zzz_server`; the cross-backend filesystem suite pins the two together.
 */
export const RPC_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

/** Size of `message` on the wire: the UTF-8 byte length of its JSON encoding. */
export const to_rpc_message_size = (message: unknown): number =>
	new TextEncoder().encode(JSON.stringify(message)).byteLength;

/**
 * The error an oversized message is refused with before it's sent —
 * `invalid_request` with `data.reason` `payload_too_large`, the same shape as
 * fuz_app's `FrontendWebsocketTransport` `max_message_bytes` refusal.
 */
export const create_rpc_message_too_large_error = (size: number): JsonrpcErrorObject => ({
	code: JSONRPC_ERROR_CODES.invalid_request,
	message: `request too large: ${format_bytes(size)}, the limit is ${format_bytes(RPC_MESSAGE_MAX_BYTES)}`,
	data: { reason: ERROR_PAYLOAD_TOO_LARGE }
});
