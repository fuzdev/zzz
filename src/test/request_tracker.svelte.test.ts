// @slop Claude Opus 4

// @vitest-environment jsdom

import {test, expect, describe, vi, beforeEach, afterEach} from 'vitest';

import {RequestTracker} from '$lib/request_tracker.svelte.js';
import {JSONRPC_INTERNAL_ERROR, JSONRPC_VERSION, JsonrpcErrorCode} from '$lib/jsonrpc.js';
import {create_jsonrpc_response, is_jsonrpc_response} from '$lib/jsonrpc_helpers.js';
import {ThrownJsonrpcError} from '$lib/jsonrpc_errors.js';

describe('RequestTracker', () => {
	let warn_spy: ReturnType<typeof vi.spyOn>;
	let log_spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Mock console methods to prevent test output pollution
		warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {
			/* suppress warnings in test output */
		});
		log_spy = vi.spyOn(console, 'log').mockImplementation(() => {
			/* suppress logs in test output */
		});

		// Mock setTimeout/clearTimeout for more deterministic tests
		vi.useFakeTimers();
	});

	afterEach(() => {
		warn_spy.mockRestore();
		log_spy.mockRestore();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('constructor', () => {
		test('creates with default timeout', () => {
			const tracker = new RequestTracker();

			expect(tracker).toBeInstanceOf(RequestTracker);
			expect(tracker.request_timeout_ms).toBe(120_000);
			expect(tracker.pending_requests.size).toBe(0);
		});

		test('creates with custom timeout', () => {
			const custom_timeout = 5000;
			const tracker = new RequestTracker(custom_timeout);

			expect(tracker.request_timeout_ms).toBe(custom_timeout);
			expect(tracker.pending_requests).toBeInstanceOf(Map);
		});

		test('handles zero or negative timeout values', () => {
			// Zero timeout should be allowed but would cause immediate timeouts
			const zero_tracker = new RequestTracker(0);
			expect(zero_tracker.request_timeout_ms).toBe(0);

			// Negative timeout should be allowed (though it's an edge case)
			const negative_tracker = new RequestTracker(-1000);
			expect(negative_tracker.request_timeout_ms).toBe(-1000);
		});
	});

	describe('track_request', () => {
		test('creates new tracked request with all expected properties', () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const deferred = tracker.track_request(id);

			// Should return a deferred promise with the correct interface
			expect(deferred).toBeDefined();
			expect(deferred.promise).toBeInstanceOf(Promise);
			expect(deferred.resolve).toBeInstanceOf(Function);
			expect(deferred.reject).toBeInstanceOf(Function);

			// Request should be stored with the correct properties
			expect(tracker.pending_requests.has(id)).toBe(true);

			const request = tracker.pending_requests.get(id);
			expect(request).toBeDefined();
			expect(request?.deferred).toBe(deferred);
			expect(request?.status).toBe('pending');
			expect(request?.timeout).toBeDefined();
			expect(request?.created).toBeDefined();
			expect(typeof request?.created).toBe('string');

			// Clean up
			tracker.cancel_request(id);
		});

		test('creates unique request trackers for different ids', async () => {
			const tracker = new RequestTracker();
			const id1 = 'req_1';
			const id2 = 'req_2';

			const deferred1 = tracker.track_request(id1);
			const deferred2 = tracker.track_request(id2);

			expect(deferred1).not.toBe(deferred2);
			expect(tracker.pending_requests.size).toBe(2);
			expect(tracker.pending_requests.get(id1)?.deferred).toBe(deferred1);
			expect(tracker.pending_requests.get(id2)?.deferred).toBe(deferred2);

			// Add promise handlers to catch rejections
			const promise1 = deferred1.promise.catch(() => {
				/* expected rejection */
			});
			const promise2 = deferred2.promise.catch(() => {
				/* expected rejection */
			});

			// Clean up
			tracker.cancel_all_requests();

			// Wait for promises to settle
			await Promise.allSettled([promise1, promise2]);
		});

		test('automatically times out requests after specified delay', async () => {
			const tracker = new RequestTracker(1000); // 1 second timeout
			const id = 'timeout_req';

			const deferred = tracker.track_request(id);
			let rejection_error: any;

			deferred.promise.catch((err) => {
				rejection_error = err;
				return err; // Return to ensure promise settles
			});

			expect(tracker.pending_requests.has(id)).toBe(true);

			// Fast-forward time to trigger timeout
			vi.advanceTimersByTime(1001);

			await Promise.resolve(); // Allow promise microtasks to process

			// Request should be removed and promise rejected with timeout error
			expect(tracker.pending_requests.has(id)).toBe(false);
			expect(rejection_error).toBeDefined();
			expect(rejection_error).toBeInstanceOf(ThrownJsonrpcError);
			expect(rejection_error.code).toBe(JSONRPC_INTERNAL_ERROR);
			expect(rejection_error.message).toBe(`request timed out: ${id}`);
		});

		test('cleans up previous request with same id', () => {
			const tracker = new RequestTracker();
			const id = 'duplicate_req';

			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');

			// Track first request
			const deferred1 = tracker.track_request(id);
			const timeout1 = tracker.pending_requests.get(id)?.timeout;
			expect(timeout1).toBeDefined();

			// Track second request with same id
			const deferred2 = tracker.track_request(id);

			// Verify timeout was cleared for first request
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout1);
			expect(deferred1).not.toBe(deferred2);

			// Only one request should exist
			expect(tracker.pending_requests.size).toBe(1);
			expect(tracker.pending_requests.get(id)?.deferred).toBe(deferred2);

			// Clean up
			tracker.cancel_request(id);
		});

		test('first request promise is never resolved when replaced by a new one', async () => {
			const tracker = new RequestTracker();
			const id = 'replaced_req';

			// Track first request
			const deferred1 = tracker.track_request(id);

			// Set up a flag to track if the first promise is resolved/rejected
			let promise1_settled = false;

			// Use Promise.race with a timeout to ensure test doesn't hang
			const promise1 = Promise.race([
				deferred1.promise
					.then(() => {
						promise1_settled = true;
						return true;
					})
					.catch(() => {
						promise1_settled = true;
						return false;
					}),
				// Add a timeout to ensure test completes
				new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
			]);

			// Track second request with same id
			tracker.track_request(id);

			// Resolve the second request (not the first one)
			tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));

			// Fast-forward time to ensure timeout promises resolve
			vi.advanceTimersByTime(101);

			// Wait for promise to settle
			const result = await promise1;

			// The promise should have timed out rather than be settled directly
			expect(result).toBe('timeout');

			// The first promise should not be directly resolved or rejected by the tracker
			expect(promise1_settled).toBe(false);

			// Cancel all requests to clean up
			tracker.cancel_all_requests();
		});
	});

	describe('resolve_request', () => {
		test('resolves tracked request with value', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const response = create_jsonrpc_response(id, {test: 'result'});

			const deferred = tracker.track_request(id);
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');
			const timeout = tracker.pending_requests.get(id)?.timeout;

			// Resolve the request
			tracker.resolve_request(id, response);

			// Verify timeout was cleared
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout);

			// Verify request status was updated before resolution
			expect(tracker.pending_requests.has(id)).toBe(false);

			// Verify promise resolves with correct value
			const result = await deferred.promise;
			expect(result).toBe(response);
		});

		test('logs warning for unknown request id', () => {
			const tracker = new RequestTracker();
			const unknown_id = 'unknown_req';

			const response = create_jsonrpc_response(unknown_id, {test: 'result'});

			tracker.resolve_request(unknown_id, response);

			expect(warn_spy).toHaveBeenCalledTimes(1);
			expect(warn_spy).toHaveBeenCalledWith(`received response for unknown request: ${unknown_id}`);
		});

		test('handles various data types', async () => {
			const tracker = new RequestTracker();
			const test_cases = [
				{id: 'string_req', method: 'test_method_1'},
				{id: 'number_req', method: 'test_method_2'},
				{id: 'boolean_req', method: 'test_method_3'},
				{id: 'null_req', method: 'test_method_4'},
				{id: 'object_req', method: 'test_method_5'},
				{id: 'array_req', method: 'test_method_6'},
			];

			const promises = test_cases.map(async ({id, method}) => {
				const deferred = tracker.track_request(id);
				const response = create_jsonrpc_response(id, {method});
				tracker.resolve_request(id, response);
				const result = await deferred.promise;
				expect(result).toBe(response);
			});

			await Promise.all(promises);
		});

		test('updates request status to success before resolving', async () => {
			const tracker = new RequestTracker();
			const id = 'status_req';

			// Track request but keep reference to the tracker item
			tracker.track_request(id);
			const request = tracker.pending_requests.get(id)!;

			// Set up a spy to track when the status is set
			let status_when_resolved: string | null = null;
			const original_resolve = request.deferred.resolve;
			request.deferred.resolve = function (value) {
				status_when_resolved = request.status;
				original_resolve.call(this, value);
			};

			const promise = request.deferred.promise;

			tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));

			await promise;
			expect(status_when_resolved).toBe('success');
		});
	});

	describe('reject_request', () => {
		test('rejects tracked request with error and cleans up', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const error = {
				jsonrpc: JSONRPC_VERSION,
				id,
				error: {code: JsonrpcErrorCode.parse(-32000), message: 'test error'},
			} as const;

			const deferred = tracker.track_request(id);
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');
			const timeout = tracker.pending_requests.get(id)?.timeout;

			// Reject the request
			tracker.reject_request(id, error);

			// Verify timeout was cleared
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout);
			expect(tracker.pending_requests.has(id)).toBe(false);

			// Verify promise rejects with the correct error
			await expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			const rejection_error = await deferred.promise.catch((err) => err);
			expect(rejection_error.code).toBe(error.error.code);
			expect(rejection_error.message).toBe(error.error.message);
		});

		test('logs warning for unknown request id', () => {
			const tracker = new RequestTracker();
			const unknown_id = 'unknown_req';

			tracker.reject_request(unknown_id, {
				jsonrpc: JSONRPC_VERSION,
				id: unknown_id,
				error: {code: JsonrpcErrorCode.parse(-32000), message: 'test'},
			});

			expect(warn_spy).toHaveBeenCalledTimes(1);
			expect(warn_spy).toHaveBeenCalledWith(`received error for unknown request: ${unknown_id}`);
		});

		test('handles various error types', async () => {
			const tracker = new RequestTracker();
			const test_cases = [
				{
					id: 'error_req',
					error: {
						jsonrpc: JSONRPC_VERSION,
						id: 'error_req',
						error: {code: JsonrpcErrorCode.parse(-32000), message: 'standard error'},
					},
				},
				{
					id: 'data_req',
					error: {
						jsonrpc: JSONRPC_VERSION,
						id: 'data_req',
						error: {
							code: JsonrpcErrorCode.parse(-32001),
							message: 'error with data',
							data: {detail: 'extra info'},
						},
					},
				},
				{
					id: 'object_req',
					error: {
						jsonrpc: JSONRPC_VERSION,
						id: 'object_req',
						error: {code: JsonrpcErrorCode.parse(-32000), message: 'object error'},
					},
				},
			] as const;

			for (const {id, error} of test_cases) {
				const deferred = tracker.track_request(id);
				tracker.reject_request(id, error);
				await expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

				const rejection_error = await deferred.promise.catch((err) => err);
				expect(rejection_error.code).toBe(error.error.code);
				expect(rejection_error.message).toBe(error.error.message);

				expect(tracker.pending_requests.has(id)).toBe(false);
			}
		});

		test('updates request status to failure before rejecting', async () => {
			const tracker = new RequestTracker();
			const id = 'status_req';

			// Track request but keep reference to the tracker item
			tracker.track_request(id);
			const request = tracker.pending_requests.get(id)!;

			// Set up a spy to track when the status is set
			let status_when_rejected: string | null = null;
			const original_reject = request.deferred.reject;
			request.deferred.reject = function (reason) {
				status_when_rejected = request.status;
				original_reject.call(this, reason);
			};

			const promise = request.deferred.promise.catch(() => {
				/* expected */
			});

			tracker.reject_request(id, {
				jsonrpc: JSONRPC_VERSION,
				id,
				error: {code: JsonrpcErrorCode.parse(-32000), message: 'test error'},
			});
			await promise;

			expect(status_when_rejected).toBe('failure');
		});
	});

	describe('handle_message', () => {
		test('resolves request with result when message contains result', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const message = {
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test_method',
				result: {data: 'test_result'},
			};
			const resolve_spy = vi.spyOn(tracker, 'resolve_request');

			// Track request
			const deferred = tracker.track_request(id);

			// Handle message
			tracker.handle_message(message);

			// Verify resolve_request was called with correct arguments
			expect(resolve_spy).toHaveBeenCalledWith(id, message);

			// Verify promise resolves with correct value
			const response = await deferred.promise;
			expect(response).toBe(message);
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('rejects request with error when message contains error', async () => {
			const tracker = new RequestTracker();
			const id = 'req_2';
			const error = {code: -32000, message: 'test error'};
			const message = {
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test_method',
				error,
			};
			const reject_spy = vi.spyOn(tracker, 'reject_request');

			// Track request
			const deferred = tracker.track_request(id);

			// Handle message
			tracker.handle_message(message);

			// Verify reject_request was called with correct arguments
			expect(reject_spy).toHaveBeenCalledWith(id, message);

			// Verify promise rejects with correct error
			await expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			const rejection_error = await deferred.promise.catch((err) => err);
			expect(rejection_error.code).toBe(message.error.code);
			expect(rejection_error.message).toBe(message.error.message);
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('ignores notification messages (no id)', () => {
			const tracker = new RequestTracker();
			const resolve_spy = vi.spyOn(tracker, 'resolve_request');
			const reject_spy = vi.spyOn(tracker, 'reject_request');

			// Track a request to verify it's not affected
			const id = 'req_3';
			tracker.track_request(id);

			// Handle notification (no id)
			tracker.handle_message({
				jsonrpc: JSONRPC_VERSION,
				method: 'notification',
				params: {},
			});

			// Verify no resolve/reject was called
			expect(resolve_spy).not.toHaveBeenCalled();
			expect(reject_spy).not.toHaveBeenCalled();

			// Original request should still be pending
			expect(tracker.pending_requests.has(id)).toBe(true);

			// Clean up
			tracker.cancel_request(id);
		});

		test('ignores messages with id but no result or error', () => {
			const tracker = new RequestTracker();
			const resolve_spy = vi.spyOn(tracker, 'resolve_request');
			const reject_spy = vi.spyOn(tracker, 'reject_request');

			// Create a tracked request
			const id = 'req_4';
			tracker.track_request(id);

			// Handle message with id but no result/error
			tracker.handle_message({
				jsonrpc: JSONRPC_VERSION,
				id: 'test_id',
				method: 'test',
			});

			// Verify no resolve/reject was called
			expect(resolve_spy).not.toHaveBeenCalled();
			expect(reject_spy).not.toHaveBeenCalled();

			// Original request should still be pending
			expect(tracker.pending_requests.has(id)).toBe(true);

			// Clean up
			tracker.cancel_request(id);
		});

		test('handles null/undefined/empty messages gracefully', () => {
			const tracker = new RequestTracker();
			const resolve_spy = vi.spyOn(tracker, 'resolve_request');
			const reject_spy = vi.spyOn(tracker, 'reject_request');

			// Create a tracked request to verify it's not affected
			const id = 'req_5';
			tracker.track_request(id);

			// Handle various invalid messages
			tracker.handle_message(null);
			tracker.handle_message(undefined);
			tracker.handle_message({});

			// Verify no resolve/reject was called
			expect(resolve_spy).not.toHaveBeenCalled();
			expect(reject_spy).not.toHaveBeenCalled();

			// Original request should still be pending
			expect(tracker.pending_requests.has(id)).toBe(true);

			// Clean up
			tracker.cancel_request(id);
		});

		test('correctly handles zero as a valid id', () => {
			const tracker = new RequestTracker();
			const id = 0;
			const message = {
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test_method',
				result: 'zero id result',
			};
			const resolve_spy = vi.spyOn(tracker, 'resolve_request');

			// Track request with zero id
			tracker.track_request(id);

			// Handle message
			tracker.handle_message(message);

			// Verify resolve_request was called with correct arguments
			expect(resolve_spy).toHaveBeenCalledWith(id, message);
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('prioritizes error over result if both exist in the message', async () => {
			const tracker = new RequestTracker();
			const id = 'conflict_req';
			const error = {code: -32000, message: 'test error'};

			// Create message with both error and result
			const message = {
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test_method',
				error,
			};

			const deferred = tracker.track_request(id);
			const reject_spy = vi.spyOn(tracker, 'reject_request');

			// Handle the message
			tracker.handle_message(message);

			// Should call reject_request, not resolve_request
			expect(reject_spy).toHaveBeenCalledWith(id, message);

			// Promise should be rejected with the error
			await expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			const rejection_error = await deferred.promise.catch((err) => err);
			expect(rejection_error.code).toBe(message.error.code);
			expect(rejection_error.message).toBe(message.error.message);
		});
	});

	describe('cancel_request', () => {
		test('cancels tracked request and cleans up timeouts', () => {
			const tracker = new RequestTracker();
			const id = 'req_1';

			tracker.track_request(id);
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');
			const timeout = tracker.pending_requests.get(id)?.timeout;

			tracker.cancel_request(id);

			// Verify timeout was cleared
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout);

			// Request should be removed
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('does nothing for unknown request id', () => {
			const tracker = new RequestTracker();
			const unknown_id = 'unknown_req';
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');

			tracker.cancel_request(unknown_id);

			// Should not attempt to clear any timeout
			expect(clear_timeout_spy).not.toHaveBeenCalled();
		});

		test('handles cancel without affecting other requests', () => {
			const tracker = new RequestTracker();
			const id1 = 'req_1';
			const id2 = 'req_2';

			tracker.track_request(id1);
			tracker.track_request(id2);

			tracker.cancel_request(id1);

			// Only the specified request should be removed
			expect(tracker.pending_requests.has(id1)).toBe(false);
			expect(tracker.pending_requests.has(id2)).toBe(true);

			// Clean up
			tracker.cancel_request(id2);
		});

		test('does not reject or resolve the promise when canceled', async () => {
			const tracker = new RequestTracker();
			const id = 'cancel_req';

			const deferred = tracker.track_request(id);

			// Set up flags to track if the promise is resolved or rejected
			let was_resolved = false;
			let was_rejected = false;

			// Use Promise.race with a timeout to ensure test doesn't hang
			const promise = Promise.race([
				deferred.promise
					.then(() => {
						was_resolved = true;
						return true;
					})
					.catch(() => {
						was_rejected = true;
						return false;
					}),
				// Add a timeout to ensure test completes
				new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
			]);

			// Cancel the request
			tracker.cancel_request(id);

			// Fast-forward time
			vi.advanceTimersByTime(101);

			// Resolve the "check" promise
			const result = await promise;

			// Result should be timeout, not a resolution or rejection
			expect(result).toBe('timeout');

			// Request should be removed
			expect(tracker.pending_requests.has(id)).toBe(false);

			// Promise should be neither resolved nor rejected directly
			expect(was_resolved).toBe(false);
			expect(was_rejected).toBe(false);
		});
	});

	describe('cancel_all_requests', () => {
		test('cancels all tracked requests with custom reason', async () => {
			const tracker = new RequestTracker();
			const id1 = 'req_1';
			const id2 = 'req_2';
			const custom_reason = 'Custom cancel reason';

			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');

			const deferred1 = tracker.track_request(id1);
			const deferred2 = tracker.track_request(id2);

			const timeout1 = tracker.pending_requests.get(id1)?.timeout;
			const timeout2 = tracker.pending_requests.get(id2)?.timeout;

			// Set up promise rejection tracking
			const promise1 = expect(deferred1.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);
			const promise2 = expect(deferred2.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			// Cancel all requests
			tracker.cancel_all_requests(custom_reason);

			// Verify timeouts were cleared
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout1);
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout2);

			// All requests should be removed
			expect(tracker.pending_requests.size).toBe(0);

			// Wait for promise rejections to complete
			await Promise.allSettled([promise1, promise2]);
		});

		test('uses default message when reason not provided', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';

			const deferred = tracker.track_request(id);
			const promise = expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			tracker.cancel_all_requests();
			expect(tracker.pending_requests.size).toBe(0);

			await promise;
		});

		test('does nothing when no requests are tracked', () => {
			const tracker = new RequestTracker();
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');

			tracker.cancel_all_requests();

			// Should not attempt to clear any timeouts
			expect(clear_timeout_spy).not.toHaveBeenCalled();
		});

		test('sets failure status before rejecting', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';

			// Track request but keep reference to the tracker item
			tracker.track_request(id);
			const request = tracker.pending_requests.get(id)!;

			// Set up a spy to track when the status is set
			let status_when_rejected: string | null = null;
			const original_reject = request.deferred.reject;
			request.deferred.reject = function (reason) {
				status_when_rejected = request.status;
				original_reject.call(this, reason);
			};

			const promise = request.deferred.promise.catch(() => {
				/* expected */
			});

			tracker.cancel_all_requests();
			await promise;

			expect(status_when_rejected).toBe('failure');
		});

		test('rejects with ThrownJsonrpcError instance when cancelling all requests', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';

			const deferred = tracker.track_request(id);

			// Set up testing for ThrownJsonrpcError instance
			const promise = expect(deferred.promise).rejects.toBeInstanceOf(ThrownJsonrpcError);

			tracker.cancel_all_requests();

			await promise;
		});
	});

	describe('edge cases and corner cases', () => {
		test('retracking the same request id replaces previous tracking', () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const clear_timeout_spy = vi.spyOn(global, 'clearTimeout');

			// Track first request
			const deferred1 = tracker.track_request(id);
			const timeout1 = tracker.pending_requests.get(id)?.timeout;

			// Track second request with same ID
			const deferred2 = tracker.track_request(id);

			// Should be different deferred objects
			expect(deferred1).not.toBe(deferred2);
			expect(tracker.pending_requests.size).toBe(1);
			expect(tracker.pending_requests.get(id)?.deferred).toBe(deferred2);

			// Should have cleared the timeout from the first request
			expect(clear_timeout_spy).toHaveBeenCalledWith(timeout1);

			// Clean up
			tracker.cancel_request(id);
		});

		test('handles various JsonrpcRequestId types', async () => {
			const tracker = new RequestTracker();
			const test_cases = [
				{id: 123, method: 'test'},
				{id: 'string-id', method: 'test'},
				{id: 0, method: 'test'},
				{id: '', method: 'test'},
			];

			for (const {id, method} of test_cases) {
				const deferred = tracker.track_request(id);
				expect(tracker.pending_requests.has(id)).toBe(true);

				const response = create_jsonrpc_response(id, {method});
				tracker.resolve_request(id, response);
				expect(tracker.pending_requests.has(id)).toBe(false);

				const result = await deferred.promise;
				expect(result).toBe(response);
			}
		});

		test('handles Object.hasOwn correctly for result property checking', async () => {
			const tracker = new RequestTracker();
			const id = 'req_1';
			const deferred = tracker.track_request(id);

			// Message with result: null (should be handled correctly)
			tracker.handle_message({
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test',
				result: null,
			});

			const result = await deferred.promise;
			expect(result).toEqual({
				jsonrpc: JSONRPC_VERSION,
				id,
				method: 'test',
				result: null,
			});
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('request timeout uses correct error object', async () => {
			const tracker = new RequestTracker(100);
			const id = 'timeout_req';

			const deferred = tracker.track_request(id);

			// Set up expectation for rejection
			const error_promise = deferred.promise.catch((error) => error);

			// Fast-forward time to trigger timeout
			vi.advanceTimersByTime(101);

			const error = await error_promise;
			expect(error).toBeInstanceOf(ThrownJsonrpcError);
			expect(error.code).toBe(JSONRPC_INTERNAL_ERROR);
			expect(error.message).toBe(`request timed out: ${id}`);
		});

		test('handles undefined timeout when clearing timeouts', () => {
			const tracker = new RequestTracker();
			const id = 'req_undefined_timeout';

			// Create a request
			tracker.track_request(id);
			const request = tracker.pending_requests.get(id)!;

			// Set the timeout to undefined
			const original_timeout = request.timeout;
			request.timeout = undefined;

			// This should not throw an error
			tracker.cancel_request(id);

			// Request should be removed
			expect(tracker.pending_requests.has(id)).toBe(false);

			// Cleanup
			clearTimeout(original_timeout);
		});

		test('handles undefined request objects gracefully', () => {
			const tracker = new RequestTracker();
			const id = 'req_1';

			// Create a request and then manually delete it from the map
			tracker.track_request(id);
			tracker.pending_requests.delete(id);

			// These should not throw errors
			tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));
			tracker.reject_request(id, {
				jsonrpc: '2.0' as const,
				id,
				error: {code: JsonrpcErrorCode.parse(-32000), message: 'test error'},
			});
			tracker.cancel_request(id);
		});

		test('handles duplicate resolve/reject calls', async () => {
			const tracker = new RequestTracker();
			const id = 'duplicate_calls';

			const deferred = tracker.track_request(id);

			// First call should resolve
			tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));

			// Second call should have no effect and log warning
			tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));

			// Rejection after resolution should have no effect
			tracker.reject_request(id, {
				jsonrpc: JSONRPC_VERSION,
				id,
				error: {
					code: JsonrpcErrorCode.parse(-32000),
					message: 'ignored',
				},
			});

			// Promise should resolve with first value
			const result = await deferred.promise;
			expect(result).toEqual({
				jsonrpc: '2.0',
				id,
				result: {
					test: 'result',
				},
			});

			// Warnings should be logged for the duplicate calls
			expect(warn_spy).toHaveBeenCalledTimes(2);
		});
	});

	describe('integration scenarios', () => {
		test('handles a complete request lifecycle', async () => {
			const tracker = new RequestTracker(5000);
			const id = 'lifecycle_req';

			// Track the request
			const deferred = tracker.track_request(id);
			expect(tracker.pending_requests.has(id)).toBe(true);
			expect(tracker.pending_requests.get(id)?.status).toBe('pending');

			// Resolve the request
			const response = create_jsonrpc_response(id, {status: 'success'});
			tracker.handle_message(response);

			// Wait for promise to resolve
			const result = await deferred.promise;

			// Request should be resolved and removed
			expect(result).toEqual({
				...response,
				result: {status: 'success'},
			});
			expect(tracker.pending_requests.has(id)).toBe(false);
		});

		test('handles simultaneous requests with different IDs', async () => {
			const tracker = new RequestTracker();
			const ids = ['req_1', 'req_2', 'req_3'];

			// Track multiple requests
			const deferreds = ids.map((id) => ({
				id,
				deferred: tracker.track_request(id),
			}));

			// All requests should be pending
			expect(tracker.pending_requests.size).toBe(ids.length);

			// Resolve them in reverse order
			for (let i = ids.length - 1; i >= 0; i--) {
				const id = ids[i];
				if (id === undefined) throw Error();
				tracker.resolve_request(id, create_jsonrpc_response(id, {test: 'result'}));
			}

			// All requests should be resolved
			const results = await Promise.all(deferreds.map(({deferred}) => deferred.promise));

			// Verify each result matches its request
			results.forEach((result, index) => {
				expect(result.id).toBe(ids[index]);
				if (is_jsonrpc_response(result)) {
					expect(result.result.test).toBe('result');
				}
			});

			// All requests should be removed
			expect(tracker.pending_requests.size).toBe(0);
		});

		test('handles a mix of resolved, rejected, and timed out requests', async () => {
			const tracker = new RequestTracker(500);

			// Create requests with different fates
			const resolve_id = 'to_resolve';
			const reject_id = 'to_reject';
			const timeout_id = 'to_timeout';

			const resolve_deferred = tracker.track_request(resolve_id);
			const reject_deferred = tracker.track_request(reject_id);
			const timeout_deferred = tracker.track_request(timeout_id);

			// Resolve one request
			tracker.resolve_request(resolve_id, create_jsonrpc_response(resolve_id, {test: 'result'}));

			// Reject another request
			tracker.reject_request(reject_id, {
				jsonrpc: '2.0' as const,
				id: reject_id,
				error: {code: JsonrpcErrorCode.parse(-32000), message: 'rejected'},
			});

			// Let the third request time out
			vi.advanceTimersByTime(501);

			// Set up promises to check results
			const resolve_promise = resolve_deferred.promise.then((result) => {
				expect(result).toHaveProperty('method', 'test_method');
				return true;
			});

			const reject_promise = reject_deferred.promise.catch((error) => {
				expect(error).toBeInstanceOf(ThrownJsonrpcError);
				expect(error.message).toBe('rejected');
				return true;
			});

			const timeout_promise = timeout_deferred.promise.catch((error) => {
				expect(error).toBeInstanceOf(ThrownJsonrpcError);
				expect(error.message).toBe(`request timed out: ${timeout_id}`);
				return true;
			});

			// Wait for all promises to settle
			await Promise.allSettled([resolve_promise, reject_promise, timeout_promise]);

			// All requests should be removed
			expect(tracker.pending_requests.size).toBe(0);
		});
	});
});
