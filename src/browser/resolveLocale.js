import { ALLOWED_LOCALES } from '../config/ALLOWED_LOCALES.js';
import { DEFAULT_LOCALE } from '../config/DEFAULT_LOCALE.js';

/**
 * The browser language mapped to a locale the completion endpoint accepts: an exact match, else
 * the first accepted locale of the same language, else DEFAULT_LOCALE.
 * @returns {string} An entry of ALLOWED_LOCALES.
 */
export function resolveLocale() {
  const language = navigator.language || DEFAULT_LOCALE;
  if (ALLOWED_LOCALES.includes(language)) return language;
  const baseLanguage = language.split('-')[0];
  return ALLOWED_LOCALES.find(locale => locale.startsWith(`${baseLanguage}-`)) ?? DEFAULT_LOCALE;
}
