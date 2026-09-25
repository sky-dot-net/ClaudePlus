/**
 * Splits a URL's host into outlet (host without "www.") and top-level domain.
 * @param {string} url Absolute URL.
 * @returns {{outlet: ?string, topLevelDomain: ?string}} The parts; both null for an invalid URL.
 */
export function hostParts(url) {
  try {
    const outlet = new URL(url).hostname.replace(/^www\./, '');
    const labels = outlet.split('.');
    return { outlet, topLevelDomain: labels.length > 1 ? labels[labels.length - 1] : '' };
  } catch {
    return { outlet: null, topLevelDomain: null };
  }
}
