/**
 * Ids used by the mocked claude.ai API: the organization, the two conversations and the root
 * message every conversation's first message replies to.
 * @type {Readonly<{organization: string, researchChat: string, secondChat: string, rootMessage: string}>}
 */
const FIXTURE_IDS = Object.freeze({
  organization: 'org-1',
  researchChat: '11111111-1111-4111-8111-111111111111',
  secondChat: '22222222-2222-4222-8222-222222222222',
  rootMessage: '00000000-0000-4000-8000-000000000000',
});

module.exports = { FIXTURE_IDS };
