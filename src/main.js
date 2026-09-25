import { ClaudePlusApp } from './app/ClaudePlusApp.js';
import { LOG_PREFIX } from './config/LOG_PREFIX.js';

new ClaudePlusApp().start().catch(error => console.error(LOG_PREFIX, 'failed to start', error));
