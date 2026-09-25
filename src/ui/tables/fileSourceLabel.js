/**
 * Who provided a file.
 * @param {FileEntry} file The file.
 * @returns {string} "User" or "Claude".
 */
export function fileSourceLabel(file) {
  return file.source === 'user' ? 'User' : 'Claude';
}
