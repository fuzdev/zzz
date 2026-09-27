/**
 * Largest JSON-RPC message the backend accepts, in bytes of its UTF-8 JSON
 * encoding — the `/api/rpc` request-body cap and the `/api/ws` message cap
 * (16 MiB on both). Twin of the backend's `RPC_MESSAGE_MAX_BYTES` in
 * `zzz_server`; the cross-backend filesystem suite pins the two together.
 * The frontend's `FrontendWebsocketTransport` takes it as
 * `max_message_bytes`, so an oversized message is refused before it's sent
 * rather than closing the socket.
 */
export const RPC_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
