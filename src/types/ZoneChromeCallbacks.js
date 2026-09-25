/**
 * Callbacks through which the zone chrome renderer asks about panels and reports tab interaction.
 * @typedef {object} ZoneChromeCallbacks
 * @property {function(string): string} titleOf Title of a panel by id.
 * @property {function(string): boolean} canClose Whether a panel's tab offers a close button.
 * @property {function(MouseEvent, string): void} onTabPress Called with the mousedown on a tab and its panel id.
 * @property {function(string, string): void} onTabActivate Called with the zone id and panel id of a clicked tab.
 * @property {function(string): void} onTabClose Called with the panel id whose close button was clicked.
 * @property {function(MouseEvent, string): void} onAddClick Called with the click on a zone's "+" button and the zone id.
 */

export {};
