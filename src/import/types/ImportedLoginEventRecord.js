/**
 * One login event from a data export's light_metadata category (login_history.json).
 * @typedef {object} ImportedLoginEventRecord
 * @property {string} accountId Account id; part of the store's compound key.
 * @property {string} timestamp ISO timestamp of the login; part of the store's compound key.
 * @property {string} ipAddress Login IP address; part of the store's compound key.
 * @property {object} userAgent Browser/OS/device details, exactly as the export gave them.
 * @property {string} method Login method (e.g. "magic_link").
 * @property {object} locationInfo Country/region/city, exactly as the export gave them.
 */

export {};
