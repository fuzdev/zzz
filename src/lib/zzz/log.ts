/**
 * zzz CLI logger — Logger + CLI semantic methods.
 *
 * @module
 */

import {Logger, create_cli_logger} from '@fuzdev/fuz_app/cli/logger.js';

export const logger = new Logger('zzz');

export const log = create_cli_logger(logger);
