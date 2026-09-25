/**
 * Characters XML 1.0 doesn't allow in documents, even escaped.
 * @type {RegExp}
 */
export const XML_FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
