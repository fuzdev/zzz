import {z} from 'zod';
import {Uuid, UuidWithDefault} from '@fuzdev/fuz_util/id.js';

export const XmlAttributeKey = z
	.string()
	.transform((s) => s.trim())
	.pipe(z.string().min(1));
export type XmlAttributeKey = z.infer<typeof XmlAttributeKey>;

export const XmlAttributeKeyWithDefault = XmlAttributeKey.default('attr');
export type XmlAttributeKeyWithDefault = z.infer<typeof XmlAttributeKeyWithDefault>;

export const XmlAttributeValue = z.string();
export type XmlAttributeValue = z.infer<typeof XmlAttributeValue>;

export const XmlAttributeValueWithDefault = XmlAttributeValue.default('');
export type XmlAttributeValueWithDefault = z.infer<typeof XmlAttributeValueWithDefault>;

// TODO is strict desired?
// Base attribute requires all fields with no defaults
export const XmlAttribute = z.strictObject({
	id: Uuid,
	key: XmlAttributeKey,
	value: XmlAttributeValue,
});
export type XmlAttribute = z.infer<typeof XmlAttribute>;

// TODO is strict desired?
// Default attribute applies defaults and includes id with default
export const XmlAttributeWithDefaults = z.strictObject({
	id: UuidWithDefault,
	key: XmlAttributeKeyWithDefault,
	value: XmlAttributeValueWithDefault,
});
export type XmlAttributeWithDefaults = z.infer<typeof XmlAttributeWithDefaults>;

// TODO Consider adding support for XML namespaces and special XML character handling if needed// TODO?: Add element, document, and CDATA section schemas to create a complete XML model
