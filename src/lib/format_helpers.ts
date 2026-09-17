// TODO should this value be fixed upstream to always be bytes? are we transforming values?
export const format_gigabytes = (gb: number): string =>
	gb < 1 ? `${Math.round(gb * 1024)} MB` : `${gb.toFixed(1)} GB`;
