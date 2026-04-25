import {Uuid} from '@fuzdev/fuz_util/id.js';

/**
 * Parse and validate a UUID parameter value from the URL.
 */
export const parse_url_param_uuid = (value: unknown): Uuid | null => {
	if (!value) return null;
	const parsed = Uuid.safeParse(value);
	return parsed.success ? parsed.data : null;
};
