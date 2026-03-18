<script lang="ts">
	import {format_timestamp} from './time_helpers.js';

	const {
		value,
	}: {
		value: Date;
	} = $props();

	const timestamp = $derived(format_timestamp(value));
	const [time_number_part, time_am_pm_part] = $derived(timestamp.split(' '));
</script>

<div class="font_family_serif font_size_xl3">
	{time_number_part}
	<small class="font_size_xl">{time_am_pm_part}</small>
</div>
