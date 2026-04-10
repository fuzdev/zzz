// TODO: Phase 5 — consolidate overlapping types with fuz_app/http/jsonrpc.js.
// zzz keeps its own jsonrpc.ts because it includes MCP-specific types
// (progressToken, _meta, notification schemas, full union types) that
// fuz_app's minimal envelope schemas don't have.

/**
 * Following MCP, Zzz supports a subset of JSON-RPC 2.0 as its message format
 * (A2A too, but I haven't looked into if they support the full spec).
 * It can be used by multiple transports including HTTP and WebSocket.
 *
 * These are the JSON-RPC types from the MCP draft in May 2025,
 * changed to include a prefix on all identifiers.
 * It's also defined with Zod schemas instead of plain TS like the MCP library.
 *
 * MCP messages are a subset of JSON-RPC:
 *
 * - `params` does not support the positional array format,
 * 		and `result` supports only `object` values, instead of being any JSON value.
 * - MCP does not support batching,
 * 		see https://github.com/modelcontextprotocol/modelcontextprotocol/pull/416
 * 		and https://github.com/modelcontextprotocol/modelcontextprotocol/pull/228
 *
 * @source https://github.com/modelcontextprotocol/typescript-sdk
 * @see https://modelcontextprotocol.io/
 * @license https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE
 *
 * MIT License
 *
 * Copyright (c) 2024 Anthropic, PBC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * @module
 */

import {z} from 'zod';

export const JSONRPC_VERSION = '2.0';
export const JSONRPC_LATEST_PROTOCOL_VERSION = 'DRAFT-2025-v2';

/**
 * A uniquely identifying id for a request in JSON-RPC.
 *
 * Like MCP but unlike JSON-RPC, the type excludes null.
 */
export const JsonrpcRequestId = z.union([z.string(), z.number()]);
export type JsonrpcRequestId = z.infer<typeof JsonrpcRequestId>;

/**
 * A JSON-RPC method name, a string with no constraints.
 */
export const JsonrpcMethod = z.string();
export type JsonrpcMethod = z.infer<typeof JsonrpcMethod>;

/**
 * A progress token, used to associate progress notifications with the original request.
 */
export const JsonrpcProgressToken = z.union([z.string(), z.number()]);
export type JsonrpcProgressToken = z.infer<typeof JsonrpcProgressToken>;

export const JsonrpcMcpMeta = z.looseObject({}); // uses looseObject to allow additional properties and support `.extend`
export type JsonrpcMcpMeta = z.infer<typeof JsonrpcMcpMeta>;

export const JsonrpcRequestParamsMeta = JsonrpcMcpMeta.extend({
	/**
	 * If specified, the caller is requesting out-of-band progress notifications
	 * for this request (as represented by notifications/progress).
	 * The value of this parameter is an opaque token that will be attached
	 * to any subsequent notifications.
	 * The receiver is not obligated to provide these notifications.
	 */
	progressToken: JsonrpcProgressToken.optional(),
});
export type JsonrpcRequestParamsMeta = z.infer<typeof JsonrpcRequestParamsMeta>;

export const JsonrpcRequestParams = z.looseObject({
	_meta: JsonrpcRequestParamsMeta.optional(),
});
export type JsonrpcRequestParams = z.infer<typeof JsonrpcRequestParams>;

export const JsonrpcNotificationParams = z.looseObject({
	/**
	 * This parameter name is reserved by MCP to allow clients and servers
	 * to attach additional metadata to their responses and notifications.
	 */
	_meta: JsonrpcMcpMeta.optional(),
});
export type JsonrpcNotificationParams = z.infer<typeof JsonrpcNotificationParams>;

export const JsonrpcParams = z.union([JsonrpcRequestParams, JsonrpcNotificationParams]);
export type JsonrpcParams = z.infer<typeof JsonrpcParams>;

export const JsonrpcResult = z.looseObject({
	/**
	 * This result property is reserved by the protocol to allow clients and servers
	 * to attach additional metadata to their responses.
	 */
	_meta: JsonrpcMcpMeta.optional(),
});
export type JsonrpcResult = z.infer<typeof JsonrpcResult>;

/**
 * A request that expects a response.
 */
export const JsonrpcRequest = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	method: JsonrpcMethod,
	params: JsonrpcRequestParams.optional(),
});
export type JsonrpcRequest = z.infer<typeof JsonrpcRequest>;

/**
 * A notification which does not expect a response.
 */
export const JsonrpcNotification = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	method: JsonrpcMethod,
	params: JsonrpcNotificationParams.optional(),
});
export type JsonrpcNotification = z.infer<typeof JsonrpcNotification>;

/**
 * A successful (non-error) response to a request.
 */
export const JsonrpcResponse = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId,
	result: JsonrpcResult,
});
export type JsonrpcResponse = z.infer<typeof JsonrpcResponse>;

// TODO add Zzz-specific error codes with mapping
// Standard JSON-RPC error codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const JSONRPC_SERVER_ERROR_START = -32000;
export const JSONRPC_SERVER_ERROR_END = -32099;
// -32000 to -32099 - Server error - Reserved for implementation-defined server-errors.

export const JsonrpcServerErrorCode = z
	.number()
	.gte(JSONRPC_SERVER_ERROR_END)
	.lte(JSONRPC_SERVER_ERROR_START)
	.brand('JsonrpcServerErrorCode');
export type JsonrpcServerErrorCode = z.infer<typeof JsonrpcServerErrorCode>;

export const JsonrpcErrorCode = z.union([
	z.literal(JSONRPC_PARSE_ERROR),
	z.literal(JSONRPC_INVALID_REQUEST),
	z.literal(JSONRPC_METHOD_NOT_FOUND),
	z.literal(JSONRPC_INVALID_PARAMS),
	z.literal(JSONRPC_INTERNAL_ERROR),
	JsonrpcServerErrorCode,
]);
export type JsonrpcErrorCode = z.infer<typeof JsonrpcErrorCode>;

export const JsonrpcErrorJson = z.looseObject({
	/**
	 * The error type that occurred.
	 */
	code: JsonrpcErrorCode,
	/**
	 * A short description of the error. The message SHOULD be limited to a concise single sentence.
	 */
	message: z.string(),
	/**
	 * Additional information about the error. The value of this member
	 * is defined by the sender (e.g. detailed error information, nested errors etc.).
	 */
	data: z.unknown().optional(),
});
export type JsonrpcErrorJson = z.infer<typeof JsonrpcErrorJson>;

/**
 * A response to a request that indicates an error occurred.
 */
export const JsonrpcErrorMessage = z.looseObject({
	jsonrpc: z.literal(JSONRPC_VERSION),
	id: JsonrpcRequestId.nullable(),
	error: JsonrpcErrorJson,
});
export type JsonrpcErrorMessage = z.infer<typeof JsonrpcErrorMessage>;

/**
 * Convenience helper union.
 */
export const JsonrpcResponseOrError = z.union([JsonrpcResponse, JsonrpcErrorMessage]);
export type JsonrpcResponseOrError = z.infer<typeof JsonrpcResponseOrError>;

/**
 * Refers to any valid JSON-RPC object that can be decoded off the wire, or encoded to be sent.
 */
export const JsonrpcMessage = z.union([
	JsonrpcRequest,
	JsonrpcNotification,
	JsonrpcResponse,
	JsonrpcErrorMessage,
	// Not supported by MCP, this shows what's omitted.
	// JsonrpcBatchRequest,
	// JsonrpcBatchResponse,
]);
export type JsonrpcMessage = z.infer<typeof JsonrpcMessage>;

export const JsonrpcMessageFromClientToServer = z.union([
	JsonrpcRequest,
	JsonrpcNotification,
	// Not supported by MCP, this shows what's omitted.
	// JsonrpcBatchRequest,
]);
export type JsonrpcMessageFromClientToServer = z.infer<typeof JsonrpcMessageFromClientToServer>;

export const JsonrpcMessageFromServerToClient = z.union([
	JsonrpcNotification,
	JsonrpcResponse,
	JsonrpcErrorMessage,
	// Not supported by MCP, this shows what's omitted.
	// JsonrpcBatchResponse,
]);
export type JsonrpcMessageFromServerToClient = z.infer<typeof JsonrpcMessageFromServerToClient>;

export const JsonrpcSingularMessage = z.union([
	JsonrpcRequest,
	JsonrpcNotification,
	JsonrpcResponse,
	JsonrpcErrorMessage,
]);
export type JsonrpcSingularMessage = z.infer<typeof JsonrpcSingularMessage>;

// Not supported by MCP, this shows what's omitted.
// export const JsonrpcBatchMessage = z.union([JsonrpcBatchRequest, JsonrpcBatchResponse]);
// export type JsonrpcBatchMessage = z.infer<typeof JsonrpcBatchMessage>;
// export const JsonrpcBatchRequest = z.array(z.union([JsonrpcRequest, JsonrpcNotification]));
// export type JsonrpcBatchRequest = z.infer<typeof JsonrpcBatchRequest>;
// export const JsonrpcBatchResponse = z.array(JsonrpcResponseOrError);
// export type JsonrpcBatchResponse = z.infer<typeof JsonrpcBatchResponse>;
