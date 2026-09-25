/**
 * Characters not allowed in file names on common operating systems.
 * @type {RegExp}
 */
export const FILE_NAME_FORBIDDEN_CHARACTERS = /[\\/:*?"<>|\u0000-\u001F]+/g;
