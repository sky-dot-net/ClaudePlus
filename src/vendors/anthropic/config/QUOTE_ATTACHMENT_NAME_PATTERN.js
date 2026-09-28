/**
 * Matches the fixed filename claude.ai gives the text file it attaches when a message quotes part
 * of an earlier one (the "Reply" button after selecting text): always
 * excerpt_from_previous_<sender>_message.txt, never a real upload worth listing as a file.
 * @type {RegExp}
 */
export const QUOTE_ATTACHMENT_NAME_PATTERN = /^excerpt_from_previous_\w+_message\.txt$/;
