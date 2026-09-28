/**
 * The hotkey commands specific to claude.ai, in the order the Anthropic settings tab lists them,
 * shaped like the app's own (id, label, defaultChord). Ids start with "anthropic." so they never
 * collide with another group's. None exist yet; a command added here appears in the settings with
 * its chord rebindable, and runs the action registered for its id.
 * @type {ReadonlyArray<Readonly<{id: string, label: string, defaultChord: string}>>}
 */
export const ANTHROPIC_HOTKEY_COMMANDS = Object.freeze([]);
