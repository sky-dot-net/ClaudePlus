const { FIXTURE_IDS } = require('./FIXTURE_IDS.cjs');
const { FIXTURE_IMAGE_URL } = require('./FIXTURE_IMAGE_URL.cjs');

/**
 * A full conversation as GET chat_conversations/{id}?tree=True returns it. The research chat has
 * an abandoned branch, a PDF attachment, a web search with two sources, a created file, a code
 * block and hostile characters in title and text; the second chat is short and has an image upload.
 * @param {string} conversationId Requested conversation id.
 * @param {number} now Epoch milliseconds the fixture times are relative to.
 * @returns {object} The conversation.
 */
function conversationFixture(conversationId, now) {
  const isoBefore = milliseconds => new Date(now - milliseconds).toISOString();
  if (conversationId !== FIXTURE_IDS.researchChat) {
    return {
      uuid: conversationId, name: 'Second chat', updated_at: isoBefore(5e6), current_leaf_message_uuid: 'b', chat_messages: [
        { uuid: 'a', parent_message_uuid: FIXTURE_IDS.rootMessage, sender: 'human', text: 'hi', created_at: isoBefore(6e6), files: [{ file_uuid: 'image-1', file_name: 'photo.png', file_kind: 'image', thumbnail_url: FIXTURE_IMAGE_URL, preview_url: FIXTURE_IMAGE_URL }] },
        { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [{ type: 'text', text: 'hello **there**' }], created_at: isoBefore(6e6 - 2000) },
      ],
    };
  }
  return {
    uuid: FIXTURE_IDS.researchChat, name: 'Research: chat <A&B> / "q"', created_at: isoBefore(3e6), updated_at: isoBefore(1e6), current_leaf_message_uuid: 'm4',
    chat_messages: [
      { uuid: 'm1', parent_message_uuid: FIXTURE_IDS.rootMessage, sender: 'human', text: 'find news', created_at: isoBefore(2e6), attachments: [{ file_name: 'notes.pdf' }] },
      { uuid: 'm2old', parent_message_uuid: 'm1', sender: 'assistant', content: [{ type: 'text', text: 'OLD BRANCH' }], created_at: isoBefore(2e6 - 1000) },
      { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', created_at: isoBefore(2e6 - 3000), content: [
        { type: 'tool_use', name: 'web_search', input: { query: 'news' } },
        { type: 'tool_result', content: [{ type: 'knowledge', title: 'Example story', url: 'https://www.example.co.uk/a' }, { title: 'Other', url: 'https://news.test.org/b' }] },
        { type: 'tool_use', name: 'create_file', input: { path: '/out/report.md', description: 'Report' } },
        { type: 'text', text: 'Here you go:\n```js\nconst x = 1;\n```\nDone [link](https://example.com) <tag> & \u0007bell' },
        { type: 'thinking', thinking: 'internal ```notes```' },
      ] },
      { uuid: 'm3', parent_message_uuid: 'm2', sender: 'human', text: 'thanks', created_at: isoBefore(1.5e6) },
      { uuid: 'm4', parent_message_uuid: 'm3', sender: 'assistant', content: [{ type: 'text', text: 'You are welcome ```inline fence```' }], created_at: isoBefore(1.5e6 - 4000) },
    ],
  };
}

module.exports = { conversationFixture };
