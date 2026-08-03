import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

export const PRODUCT_ID = 'agent-channel-host';
export const PRODUCT_TITLE = 'Agent Channel Host';
export const CLI_NAME = 'agent-channel';
export const PRODUCT_VERSION = packageJson.version;
export const DATA_HOME_ENV = 'AGENT_CHANNEL_HOME';
export const LEGACY_DATA_HOME_ENV = 'DINGTALK_CODEX_HOME';
