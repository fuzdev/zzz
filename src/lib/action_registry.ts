// @slop Claude Opus 4

import type {
	ActionSpecUnion,
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
} from '@fuzdev/fuz_app/action_spec.js';
import {to_action_spec_identifier} from './action_helpers.js';

// TODO use derived or `??=` in lazy getters for memoization

/**
 * Utility class to manage and query action specifications.
 * Provides helper methods to get actions by various criteria.
 */
export class ActionRegistry {
	specs: Array<ActionSpecUnion>;

	constructor(specs: Array<ActionSpecUnion>) {
		this.specs = specs;
	}

	get spec_by_method(): Map<string, ActionSpecUnion> {
		return new Map(this.specs.map((spec) => [spec.method, spec]));
	}

	get request_response_specs(): Array<RequestResponseActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'request_response');
	}

	get remote_notification_specs(): Array<RemoteNotificationActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'remote_notification');
	}

	get local_call_specs(): Array<LocalCallActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'local_call');
	}

	get backend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.kind !== 'local_call');
	}

	get frontend_specs(): Array<ActionSpecUnion> {
		return this.specs;
	}

	get backend_to_frontend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'backend' || spec.initiator === 'both');
	}

	get frontend_to_backend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'frontend' || spec.initiator === 'both');
	}

	get methods(): Array<string> {
		return this.specs.map((spec) => spec.method);
	}

	get request_response_methods(): Array<string> {
		return this.request_response_specs.map((spec) => spec.method);
	}

	get remote_notification_methods(): Array<string> {
		return this.remote_notification_specs.map((spec) => spec.method);
	}

	get local_call_methods(): Array<string> {
		return this.local_call_specs.map((spec) => spec.method);
	}

	get backend_methods(): Array<string> {
		return this.backend_specs.map((spec) => spec.method);
	}

	get frontend_methods(): Array<string> {
		return this.frontend_specs.map((spec) => spec.method);
	}

	get frontend_to_backend_methods(): Array<string> {
		return this.frontend_to_backend_specs.map((spec) => spec.method);
	}

	get backend_to_frontend_methods(): Array<string> {
		return this.backend_to_frontend_specs.map((spec) => spec.method);
	}

	get_schema_imports(): Array<string> {
		return this.specs.map((spec) => to_action_spec_identifier(spec.method));
	}
}
