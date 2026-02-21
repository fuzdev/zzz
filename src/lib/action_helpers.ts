export const ACTION_DATE_FORMAT = 'MMM d, p';
export const ACTION_TIME_FORMAT = 'p';

// TODO rethink there, see also `codegen.ts`
export const to_action_spec_identifier = (method: string): string => `${method}_action_spec`;
export const to_action_spec_input_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.input`;
export const to_action_spec_output_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.output`;
