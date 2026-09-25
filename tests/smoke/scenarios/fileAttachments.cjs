/**
 * Checks file attachments: a dropped and a pasted file are uploaded and shown as chips, a chip can
 * be removed, and the next prompt carries the remaining upload's id and clears the chips.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function fileAttachments(run) {
  const { page } = run;
  const chips = run.composer.locator('.claude-plus-staged-file');
  await page.evaluate(dropAndPasteFiles);
  await page.waitForFunction(() => document.querySelectorAll('.claude-plus-staged-file').length === 2 && !document.querySelector('.claude-plus-staged-file--uploading'));
  run.check('dropped and pasted files are uploaded and shown as chips', run.api.uploadCount === 2 && await chips.count() === 2);
  await chips.filter({ hasText: 'dropped.txt' }).locator('.claude-plus-staged-file__remove').click();
  run.check('a staged file can be removed', await chips.count() === 1);
  const sentBefore = run.api.completions.length;
  await run.sendPrompt('with attachment');
  const completion = run.api.completions[sentBefore];
  run.check('the prompt carries the staged upload', JSON.stringify(completion?.files) === JSON.stringify(['upload-pasted.txt']), JSON.stringify(completion?.files));
  run.check('sending clears the staged files', await chips.count() === 0 && await run.composer.locator('[data-name="stagedFiles"]').isHidden());
}

/**
 * Runs in the page: drops one file onto the composer and pastes another into its prompt input.
 * @returns {void}
 */
function dropAndPasteFiles() {
  const promptInput = document.querySelector('[data-name="promptInput"]');
  const dropped = new DataTransfer();
  dropped.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
  promptInput.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
  const pasted = new DataTransfer();
  pasted.items.add(new File(['pasted'], 'pasted.txt', { type: 'text/plain' }));
  promptInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }));
}

module.exports = { fileAttachments };
