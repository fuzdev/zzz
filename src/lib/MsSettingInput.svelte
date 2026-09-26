<script lang="ts">
	import type { MsSettingBounds } from './socket_helpers.ts';

	/**
	 * A millisecond setting as a range slider plus a number field. Both are
	 * one-way: the slider commits as it moves (its values are always in
	 * range), the number field commits on `change` (blur or Enter) so the
	 * setter's coercion and clamping don't fight each keystroke. After a
	 * commit the field shows the value the setter kept.
	 */
	const {
		id,
		label,
		value,
		bounds,
		range_max = bounds.max,
		step,
		onvalue
	}: {
		/** The number field's id, for an external `<label for>`. */
		id?: string;
		/** Accessible name for the slider, which has no `<label>` of its own. */
		label: string;
		/** The current setting. */
		value: number;
		bounds: MsSettingBounds;
		/**
		 * Slider maximum, when the useful range is narrower than `bounds` — the
		 * number field still accepts up to `bounds.max`.
		 */
		range_max?: number;
		step: number;
		/** Commits a new value — `NaN` for an empty field; the setter decides what to keep. */
		onvalue: (value: number) => void;
	} = $props();

	const commit = (input: HTMLInputElement): void => {
		onvalue(input.valueAsNumber);
		input.value = String(value);
	};
</script>

<div class="display:flex gap_xs">
	<input
		type="range"
		aria-label={label}
		min={bounds.min}
		max={range_max}
		{step}
		class="flex:1 sm plain"
		{value}
		oninput={(e) => commit(e.currentTarget)}
	/>
	<input
		{id}
		type="number"
		min={bounds.min}
		max={bounds.max}
		{step}
		class="input-xs sm plain"
		{value}
		onchange={(e) => commit(e.currentTarget)}
	/>
</div>
