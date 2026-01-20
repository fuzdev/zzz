<script lang="ts">
	import {slide} from 'svelte/transition';

	import type {PartUnion} from './part.svelte.js';
	import XmlAttributeEditor from './XmlAttributeEditor.svelte';
	import {GLYPH_ADD, GLYPH_PLACEHOLDER} from './glyphs.js';
	import Glyph from './Glyph.svelte';

	const {
		part,
	}: {
		part: PartUnion;
	} = $props();

	let input_el: HTMLInputElement | undefined;
</script>

<div class="column gap_xs">
	<div class="display:flex align-items:center gap_xs2">
		<label
			class="row mb_0 pr_md"
			title="when enabled, the prompt's content will be wrapped with the xml tag '{part.xml_tag_name ||
				part.xml_tag_name_default}'"
		>
			<input
				class="plain compact"
				type="checkbox"
				bind:checked={
					() => part.has_xml_tag,
					(v) => {
						part.has_xml_tag = v;
						if (v) input_el?.focus(); // I like this compared to an $effect placed in some arbitrary place
					}
				}
			/>
			<small>xml tag</small>
		</label>
		<input
			class="plain flex:1 compact"
			class:dormant={!part.has_xml_tag}
			placeholder={part.has_xml_tag
				? GLYPH_PLACEHOLDER + ' ' + part.xml_tag_name_default
				: undefined}
			bind:value={part.xml_tag_name}
			bind:this={input_el}
		/>
		<button
			type="button"
			class="plain compact"
			title="add xml attribute"
			onclick={() => part.add_attribute()}
		>
			<Glyph glyph={GLYPH_ADD} />
		</button>
	</div>

	<ul class="unstyled">
		{#each part.attributes as attribute (attribute.id)}
			<li transition:slide class="py_xs4">
				<XmlAttributeEditor
					{attribute}
					dormant={!part.has_xml_tag}
					onupdate={(updates) => part.update_attribute(attribute.id, updates)}
					onremove={() => part.remove_attribute(attribute.id)}
				/>
			</li>
		{/each}
	</ul>
</div>
