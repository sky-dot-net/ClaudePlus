/**
 * Whether a hex color reads as dark, by perceived brightness (the YIQ formula) rather than raw
 * component averages, so the answer matches what the eye actually sees.
 * @param {string} hexColor A color in "#rrggbb" form.
 * @returns {boolean} True when it reads as dark.
 */
export function isDarkColor(hexColor) {
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
}
