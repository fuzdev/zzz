import {describe_standard_adversarial_headers} from '@fuzdev/fuz_app/testing/adversarial_headers.js';

const TRUSTED_PROXY = '127.0.0.1';
const DEV_ORIGIN = 'http://localhost:5173';

describe_standard_adversarial_headers(
	'zzz adversarial header attacks (dev origin)',
	{
		trusted_proxies: [TRUSTED_PROXY, '::1'],
		allowed_origins: DEV_ORIGIN,
		connection_ip: TRUSTED_PROXY,
	},
	DEV_ORIGIN,
);
