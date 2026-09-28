/**
 * Checks claude.ai's "Reply" flow: selecting text in a message offers a floating Reply button,
 * clicking it attaches a quote chip to the composer, and sending carries the quote as an
 * attachment shaped exactly like claude.ai's own quote-reply attachments.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function quoteReply(run) {
  const { page } = run;
  await page.evaluate(selectTextInFirstMessage);
  const replyButton = page.locator('.claude-plus-selection-reply');
  await replyButton.waitFor();
  await replyButton.click();
  const quoteChip = run.composer.locator('.claude-plus-pending-quote');
  run.check('selecting text and clicking Reply attaches a quote chip to the composer', await quoteChip.isVisible());
  const sentBefore = run.api.completions.length;
  await run.sendPrompt('using the quote');
  const completion = run.api.completions[sentBefore];
  const attachment = completion?.attachments?.[0];
  run.check('sending with a pending quote attaches it in claude.ai\'s own shape', isQuoteAttachment(attachment), JSON.stringify(attachment));
  run.check('the quote chip clears after sending', await quoteChip.count() === 0);
}

/**
 * Whether an attachment is shaped exactly like claude.ai's own quote-reply attachment for the
 * first 4 characters of the first message's text ("find news"), quoted from a human message.
 * @param {?object} attachment The completion request's first attachment, if any.
 * @returns {boolean} True when it matches.
 */
function isQuoteAttachment(attachment) {
  if (!attachment) return false;
  return attachment.file_name === 'excerpt_from_previous_human_message.txt' && attachment.extracted_content === 'find' && attachment.file_type === 'txt';
}

/**
 * Runs in the page: selects the first 4 characters of the first message's text and reports the
 * selection to the message list the same way a real mouse-drag selection would.
 * @returns {void}
 */
function selectTextInFirstMessage() {
  const textElement = document.querySelector('[data-message-index="0"] .claude-plus-message-text');
  const range = document.createRange();
  range.setStart(textElement.firstChild, 0);
  range.setEnd(textElement.firstChild, 4);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.querySelector('.claude-plus-message-list').dispatchEvent(new Event('mouseup', { bubbles: true }));
}

module.exports = { quoteReply };
