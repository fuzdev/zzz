<script lang="ts">
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import type { XmlAttributeWithDefaults } from './xml.ts';
	import { icon_remove } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	const {
		attribute,
		dormant: dormant_prop,
		onupdate,
		onremove
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
		class="plain sm"
		class:dormant
		placeholder="key"
		value={attribute.key}
		oninput={(e) => onupdate({ key: e.currentTarget.value })}
	/>
	<input
		class="plain sm"
		class:dormant
		placeholder="value"
		value={attribute.value}
		oninput={(e) => onupdate({ value: e.currentTarget.value })}
	/>
	<ConfirmButton
		onconfirm={onremove}
		title="remove attribute {attribute.key || ''}"
		class="plain sm"
	>
		<Svg data={icon_remove} />
	</ConfirmButton>
</div>
