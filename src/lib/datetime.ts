import {
	brand,
	iso_datetime,
	pipe,
	string,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

/**
 * Branded datetime schema: an RFC 3339 date and time in UTC with a real
 * calendar date, `Z` and no offset, the seconds required, and a fraction of
 * at most 9 digits or none — fuz_app's `Timestamp` grammar, branded.
 */
export const Datetime = brand(pipe(string, iso_datetime), 'Datetime');
export type Datetime = Infer<typeof Datetime>;

/** Returns an ISO 8601 datetime string for the current time. */
export const get_datetime_now = (): Datetime => new Date().toISOString() as Datetime;

/** `Datetime` that defaults to `get_datetime_now()` when the input is `undefined`. */
export const DatetimeNow = with_default_fn(Datetime, get_datetime_now);
export type DatetimeNow = Infer<typeof DatetimeNow>;
