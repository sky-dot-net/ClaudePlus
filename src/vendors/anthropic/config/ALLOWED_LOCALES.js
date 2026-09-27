/**
 * Locale tags the completion endpoint accepts. navigator.language (e.g. "en-GB", "de") is
 * usually not one of them, and sending it gets the request rejected with a 400.
 * @type {ReadonlyArray<string>}
 */
export const ALLOWED_LOCALES = Object.freeze(['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID']);
