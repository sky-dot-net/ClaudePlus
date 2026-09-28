/**
 * Version of the conversation summaries' content. A stored summary of another version is
 * recomputed the next time its conversation is indexed, opened, imported or reconciled, so a change
 * to what a summary contains reaches conversations whose own timestamp did not change.
 * @type {number}
 */
export const SUMMARY_VERSION = 2;
