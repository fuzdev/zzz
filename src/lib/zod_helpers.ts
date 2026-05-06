import {z} from 'zod';
import {ensure_end, ensure_start, strip_end, strip_start} from '@fuzdev/fuz_util/string.js';
import {SvelteMap} from 'svelte/reactivity';

export const Any = z.any();
export type Any = z.infer<typeof Any>;

export const HttpStatus = z.number().int();
export type HttpStatus = z.infer<typeof HttpStatus>;

export const TypeLiteral = z.string().min(1).brand('TypeLiteral');
export type TypeLiteral = z.infer<typeof TypeLiteral>;

// TODO @many how to handle paths? need some more structure to the way they're normalized and joined
// TODO rethink with ensure/turn usages, normally we'd want to validate these not transform
export const PathWithTrailingSlash = z.string().transform((v) => ensure_end(v, '/'));
export type PathWithTrailingSlash = z.infer<typeof PathWithTrailingSlash>;

export const PathWithoutTrailingSlash = z.string().transform((v) => strip_end(v, '/'));
export type PathWithoutTrailingSlash = z.infer<typeof PathWithoutTrailingSlash>;

export const PathWithLeadingSlash = z.string().transform((v) => ensure_start(v, '/'));
export type PathWithLeadingSlash = z.infer<typeof PathWithLeadingSlash>;

export const PathWithoutLeadingSlash = z.string().transform((v) => strip_start(v, '/'));
export type PathWithoutLeadingSlash = z.infer<typeof PathWithoutLeadingSlash>;

export const SvelteMapSchema = z.instanceof(SvelteMap);
export type SvelteMapSchema = z.infer<typeof SvelteMapSchema>;
