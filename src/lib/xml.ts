import {
	min_length,
	object,
	pipe,
	string,
	transform,
	with_default,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import { UuidWithDefault } from '@fuzdev/fuz_app/primitive_schemas.ts';

export const XmlAttributeKey = pipe(
	string,
	transform((v: string) => v.trim()),
	min_length(1)
);
export type XmlAttributeKey = Infer<typeof XmlAttributeKey>;

export const XmlAttributeKeyWithDefault = with_default(XmlAttributeKey, 'attr');
export type XmlAttributeKeyWithDefault = Infer<typeof XmlAttributeKeyWithDefault>;

export const XmlAttributeValue = string;
export type XmlAttributeValue = Infer<typeof XmlAttributeValue>;

export const XmlAttributeValueWithDefault = with_default(XmlAttributeValue, '');
export type XmlAttributeValueWithDefault = Infer<typeof XmlAttributeValueWithDefault>;

// TODO is strict desired?
// Default attribute applies defaults and includes id with default
export const XmlAttributeWithDefaults = object({
	id: UuidWithDefault,
	key: XmlAttributeKeyWithDefault,
	value: XmlAttributeValueWithDefault
});
export type XmlAttributeWithDefaults = Infer<typeof XmlAttributeWithDefaults>;

// TODO Consider adding support for XML namespaces and special XML character handling if needed// TODO?: Add element, document, and CDATA section schemas to create a complete XML model
