import { ClaudePlusApp } from './app/ClaudePlusApp.js';
import { ClaudePlusLauncher } from './app/ClaudePlusLauncher.js';
import { LOG_PREFIX } from './config/LOG_PREFIX.js';

/**
 * The launcher button; app.launch() is only referenced once app exists below, but this closure
 * isn't called until the button is clicked, well after that.
 * @type {ClaudePlusLauncher}
 */
const launcher = new ClaudePlusLauncher(() => app.launch().catch(error => console.error(LOG_PREFIX, 'failed to start', error)));

/**
 * The app, not started until the launcher button is clicked.
 * @type {ClaudePlusApp}
 */
const app = new ClaudePlusApp(launcher);

launcher.mount();
