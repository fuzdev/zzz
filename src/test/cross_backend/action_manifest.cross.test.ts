/**
 * Holds zzz's own request specs to their Rust twins: the methods `testing_zzzd`
 * registers, each one's input shape, auth axes, role and credential gates,
 * `side_effects`, and rate-limit class, equal what the TS specs declare. A
 * spec added, dropped, or changed on one side alone fails here.
 *
 * The frontend never sees a backend's auth shape, so nothing else catches a
 * method one side calls account-grain and the other gates on an actor. The
 * spine's standard bundle is fuz_app's to compare, and isn't in either list.
 *
 * @module
 */

import { test } from 'vitest';
import { is_protocol_action_method } from '@fuzdev/fuz_app/actions/action_codegen.ts';
import type { RequestResponseActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';
import { build_action_manifest } from '@fuzdev/fuz_app/testing/cross_backend/action_manifest.ts';
import { assert_action_manifests_equal } from '@fuzdev/fuz_app/testing/cross_backend/action_manifest_parity.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { capture_action_manifest } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import { all_action_specs } from '#lib/action_specs.ts';

const handle = inject_backend_handle();

/**
 * The manifest action lists itself beside the specs it reports. Dropped by
 * name: its TS spec's module imports the TS spine's server, which zzz
 * doesn't install.
 */
const MANIFEST_METHOD = '_testing_action_manifest';

test("zzz's request specs match the backend's registered specs", async () => {
	const declared = build_action_manifest(
		// requests the backend answers: a request it initiates has no handler there
		all_action_specs.filter(
			(spec): spec is RequestResponseActionSpec =>
				spec.kind === 'request_response' &&
				spec.initiator !== 'backend' &&
				!is_protocol_action_method(spec.method)
		)
	);
	const registered = await capture_action_manifest(handle);

	assert_action_manifests_equal(
		declared,
		{ methods: registered.methods.filter((entry) => entry.method !== MANIFEST_METHOD) },
		{ a: 'the TS specs', b: 'testing_zzzd' }
	);
});
