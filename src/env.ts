import { defineEnvVars } from '@sveltejs/kit/env';

// the frontend's env vars, imported from `$app/env/public` by `src/lib/constants.ts`
// (which parses them and applies the defaults); static because the UI is a prerendered
// SPA with no server to read them at runtime, so the build bakes them in

/** An unset var reads as empty, so every var is optional and `constants.ts` supplies the default. */
const optional = (value: string | undefined): string => value ?? '';

export const variables = defineEnvVars({
	PUBLIC_ZZZ_SERVER_PROTOCOL: {
		public: true,
		static: true,
		schema: optional,
		description: '`http` or `https`; empty → `http`'
	},
	PUBLIC_ZZZ_SERVER_HOST: {
		public: true,
		static: true,
		schema: optional,
		description: 'server hostname; empty → `localhost`'
	},
	PUBLIC_ZZZ_SERVER_PORT: {
		public: true,
		static: true,
		schema: optional,
		description:
			"the server the UI calls (dev: the Vite port, which proxies `/api`); empty → the page's own origin"
	},
	PUBLIC_ZZZ_SERVER_API_PATH: {
		public: true,
		static: true,
		schema: optional,
		description: 'API endpoint path; empty → `/api`'
	},
	PUBLIC_ZZZ_WEBSOCKET_URL: {
		public: true,
		static: true,
		schema: optional,
		description:
			"WebSocket URL (dev: `zzzd` directly); empty → `<API path>/ws` on the page's origin"
	}
});
