<script lang="ts">
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import type {XmlAttributeWithDefaults} from './xml.js';
	import {GLYPH_REMOVE} from './glyphs.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Glyph from './Glyph.svelte';

	const {
		attribute,
		dormant: dormant_prop,
		onupdate,
		onremove,
	}: {
		attribute: XmlAttributeWithDefaults;
		dormant?: boolean | undefined;
		onupdate: (updates: Partial<OmitStrict<XmlAttributeWithDefaults, 'id'>>) => void;
		onremove: () => void;
	} = $props();

	const dormant = $derived(dormant_prop || !attribute.key);
</script>

<div class="display:flex gap_xs2 align-items:center" class:dormant_wrapper={!attribute.key}>
	<input
		class="plain compact"
		class:dormant
		placeholder="key"
		value={attribute.key}
		oninput={(e) => onupdate({key: e.currentTarget.value})}
	/>
	<input
		class="plain compact"
		class:dormant
		placeholder="value"
		value={attribute.value}
		oninput={(e) => onupdate({value: e.currentTarget.value})}
	/>
	<ConfirmButton
		onconfirm={onremove}
		title="remove attribute {attribute.key || ''}"
		class="plain compact"
	>
		<Glyph glyph={GLYPH_REMOVE} />
	</ConfirmButton>
</div>
