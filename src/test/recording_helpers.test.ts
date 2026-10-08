import { test, describe, assert } from 'vitest';

import {
	RECORDING_FORMATS,
	confirm_unload_while_recording,
	format_recording_duration,
	pick_recording_format,
	to_microphone_error_message,
	to_recording_name
} from '$lib/recording_helpers.ts';

describe('pick_recording_format', () => {
	test('prefers Opus in WebM', () => {
		assert.deepEqual(
			pick_recording_format(() => true),
			{ mime_type: 'audio/webm;codecs=opus', extension: 'webm' }
		);
	});

	test('falls back through the list in order', () => {
		assert.strictEqual(pick_recording_format((type) => !type.includes('webm'))?.extension, 'ogg');
		assert.strictEqual(pick_recording_format((type) => type === 'audio/mp4')?.extension, 'm4a');
	});

	test('is null when the browser records none of them', () => {
		assert.strictEqual(
			pick_recording_format(() => false),
			null
		);
	});

	test('every format has an extension the backend finalizes and serves as audio or video', () => {
		// twins of `MediaContainer::from_path` and `media_content_type` in `zzz_server`
		const finalizable = new Set(['webm', 'weba', 'mkv', 'mka', 'ogg', 'oga', 'opus', 'mp4', 'm4a']);
		for (const format of RECORDING_FORMATS) {
			assert.ok(finalizable.has(format.extension), format.extension);
		}
	});
});

describe('to_recording_name', () => {
	test('is the local date and time, zero-padded and sortable', () => {
		assert.strictEqual(to_recording_name(new Date(2026, 0, 31, 9, 5, 7)), '2026-01-31_09-05-07');
		assert.strictEqual(to_recording_name(new Date(2026, 11, 1, 23, 59, 59)), '2026-12-01_23-59-59');
	});

	test('has no character a path or a shell minds', () => {
		assert.match(to_recording_name(new Date()), /^[0-9_-]+$/);
	});
});

describe('format_recording_duration', () => {
	test('formats minutes and seconds, then hours', () => {
		assert.strictEqual(format_recording_duration(0), '0:00');
		assert.strictEqual(format_recording_duration(999), '0:00');
		assert.strictEqual(format_recording_duration(65_000), '1:05');
		assert.strictEqual(format_recording_duration(59 * 60_000 + 59_000), '59:59');
		assert.strictEqual(format_recording_duration(3_600_000), '1:00:00');
		assert.strictEqual(format_recording_duration(3_725_000), '1:02:05');
	});

	test('never goes negative', () => {
		assert.strictEqual(format_recording_duration(-5000), '0:00');
	});
});

describe('to_microphone_error_message', () => {
	test('names the cause by the error name', () => {
		assert.include(to_microphone_error_message({ name: 'NotAllowedError' }), 'denied');
		assert.include(to_microphone_error_message({ name: 'NotFoundError' }), 'no microphone');
		assert.include(to_microphone_error_message({ name: 'NotReadableError' }), 'in use');
	});

	test('has a fallback for anything else', () => {
		for (const error of [null, undefined, 'nope', {}, new Error('x')]) {
			assert.strictEqual(to_microphone_error_message(error), "couldn't open the microphone");
		}
	});
});

describe('confirm_unload_while_recording', () => {
	const create_event = (): BeforeUnloadEvent & { prevented: boolean } => {
		const event = {
			prevented: false,
			returnValue: undefined as unknown,
			preventDefault() {
				this.prevented = true;
			}
		};
		return event as unknown as BeforeUnloadEvent & { prevented: boolean };
	};

	test('asks while the recorder is active', () => {
		const event = create_event();
		confirm_unload_while_recording(event, { active: true });
		assert.ok(event.prevented);
		assert.strictEqual(event.returnValue as unknown, ''); // eslint-disable-line @typescript-eslint/no-deprecated
	});

	test('does nothing when idle or without an app', () => {
		for (const recorder of [{ active: false }, undefined]) {
			const event = create_event();
			confirm_unload_while_recording(event, recorder);
			assert.ok(!event.prevented);
		}
	});
});
