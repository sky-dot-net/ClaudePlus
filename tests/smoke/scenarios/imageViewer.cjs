/**
 * Checks image uploads in a chat: shown inline, opened in the viewer on click, zoomed by the
 * mouse wheel, and closed by Escape.
 * @param {SmokeRun} run The smoke run.
 * @returns {Promise<void>} Resolves once checked.
 */
async function imageViewer(run) {
  const { page } = run;
  const inlineImage = page.locator('.claude-plus-message-image').first();
  run.check('image uploads are shown inline', await inlineImage.count() === 1);
  await inlineImage.click();
  const viewerImage = page.locator('.claude-plus-image-viewer__image');
  run.check('clicking an image opens the viewer', await viewerImage.count() === 1);
  await page.locator('.claude-plus-image-viewer__frame').hover();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(50);
  const transform = await viewerImage.evaluate(image => image.style.transform);
  run.check('scrolling zooms the image', transform.includes('scale(1.15)'), transform);
  await page.keyboard.press('Escape');
  run.check('Escape closes the viewer', await page.locator('.claude-plus-image-viewer-overlay').count() === 0);
}

module.exports = { imageViewer };
