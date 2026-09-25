/**
 * A split dividing its area between two or more child nodes.
 * @typedef {object} SplitNode
 * @property {'split'} type Node discriminator.
 * @property {'row'|'column'} direction 'row' places children side by side, 'column' stacks them.
 * @property {number[]} sizes Fraction of the area given to each child; sums to 1.
 * @property {DockNode[]} children Child nodes, at least two.
 */

export {};
