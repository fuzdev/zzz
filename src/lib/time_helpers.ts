import { format } from 'date-fns';

import { FILE_DATETIME_FORMAT, FILE_SHORT_DATE_FORMAT, FILE_TIME_FORMAT } from './cell_helpers.ts';

export type TimeValue = string | number | Date;

// TODO rethink these names and the design

export const format_timestamp = (value: TimeValue | null | undefined, fallback = ''): string =>
	!value ? fallback : format(value, 'h:mm a');

export const format_short_date = (value: TimeValue | null | undefined, fallback = ''): string =>
	!value ? fallback : format(value, FILE_SHORT_DATE_FORMAT);

export const format_datetime = (value: TimeValue | null | undefined, fallback = ''): string =>
	!value ? fallback : format(value, FILE_DATETIME_FORMAT);

export const format_time = (value: TimeValue | null | undefined, fallback = ''): string =>
	!value ? fallback : format(value, FILE_TIME_FORMAT);

// TODO replace with `date-fns`?
/**
 * Formats a duration for display: milliseconds under a second, else seconds to
 * at most one decimal place with no trailing zero, like `1 second` or `1.5 seconds`.
 */
export const format_ms_to_readable = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 100) / 10;
	return `${seconds} second${seconds === 1 ? '' : 's'}`;
};
