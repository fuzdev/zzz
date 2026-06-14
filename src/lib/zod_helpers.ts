import {z} from 'zod';
import {ensure_end, ensure_start, strip_end} from '@fuzdev/fuz_util/string.js';

// TODO @many how to handle paths? need some more structure to the way they're normalized and joined
// TODO rethink with ensure/turn usages, normally we'd want to validate these not transform
export const PathWithTrailingSlash = z.string().transform((v) => ensure_end(v, '/'));
export type PathWithTrailingSlash = z.infer<typeof PathWithTrailingSlash>;

export const PathWithoutTrailingSlash = z.string().transform((v) => strip_end(v, '/'));
export type PathWithoutTrailingSlash = z.infer<typeof PathWithoutTrailingSlash>;

export const PathWithLeadingSlash = z.string().transform((v) => ensure_start(v, '/'));
export type PathWithLeadingSlash = z.infer<typeof PathWithLeadingSlash>;
