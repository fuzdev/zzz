import { pipe, string, transform, type Infer } from '@fuzdev/fuz_schema/schema.ts';
import { ensure_end, ensure_start, strip_end } from '@fuzdev/fuz_util/string.ts';

// TODO @many how to handle paths? need some more structure to the way they're normalized and joined
// TODO rethink with ensure/turn usages, normally we'd want to validate these not transform
export const PathWithTrailingSlash = pipe(
	string,
	transform((v: string) => ensure_end(v, '/'))
);
export type PathWithTrailingSlash = Infer<typeof PathWithTrailingSlash>;

export const PathWithoutTrailingSlash = pipe(
	string,
	transform((v: string) => strip_end(v, '/'))
);
export type PathWithoutTrailingSlash = Infer<typeof PathWithoutTrailingSlash>;

export const PathWithLeadingSlash = pipe(
	string,
	transform((v: string) => ensure_start(v, '/'))
);
export type PathWithLeadingSlash = Infer<typeof PathWithLeadingSlash>;
