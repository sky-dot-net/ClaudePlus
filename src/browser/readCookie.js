/**
 * Reads a cookie of the current page.
 * @param {string} name Cookie name.
 * @returns {?string} The decoded value, or null when the cookie isn't set.
 */
export function readCookie(name) {
  const cookie = document.cookie.split('; ').find(entry => entry.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}
