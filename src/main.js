import { ClaudePlusApp } from './app/ClaudePlusApp.js';
import { ClaudePlusLauncher } from './app/ClaudePlusLauncher.js';
import { LOG_PREFIX } from './config/LOG_PREFIX.js';

/**
 * The app, not started until the launcher button is clicked.
 * @type {ClaudePlusApp}
 */
const app = new ClaudePlusApp();

new ClaudePlusLauncher(() => app.launch().catch(error => console.error(LOG_PREFIX, 'failed to start', error))).mount();
