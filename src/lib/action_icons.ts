import type {SvgData} from '@fuzdev/fuz_ui/svg.ts';
import {
	icon_ping,
	icon_response,
	icon_session,
	icon_file,
	icon_action,
	icon_action_local_call,
	icon_action_request_response,
	icon_action_remote_notification,
} from '@fuzdev/fuz_ui/icons.ts';
import type {ActionKind} from '@fuzdev/fuz_app/actions/action_spec.ts';

import type {ActionMethod} from './action_metatypes.ts';

export const get_icon_for_action_method = (method: ActionMethod): SvgData => {
	switch (method) {
		case 'ping':
			return icon_ping;
		case 'completion_create':
			return icon_response;
		case 'session_load':
			return icon_session;
		case 'diskfile_update':
		case 'diskfile_delete':
		case 'filer_change':
			return icon_file;
		default:
			return icon_action;
	}
};

export const get_icon_for_action_kind = (kind: ActionKind): SvgData => {
	switch (kind) {
		case 'local_call':
			return icon_action_local_call;
		case 'request_response':
			return icon_action_request_response;
		case 'remote_notification':
			return icon_action_remote_notification;
		default:
			return icon_action;
	}
};
