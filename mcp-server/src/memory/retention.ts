/**
 * Calculates the retention score of a node based on the Ebbinghaus formula.
 * Mirrors the browser-side formula in dashboard/dag-blackboard.js.
 * 
 * @param node - The node to calculate the retention score for.
 * @param now - The current timestamp in milliseconds since epoch.
 * @returns The retention score of the node.
 */
export function retentionOf(node: { confidence: number; lastReviewedAt: number; halfLifeDays: number }, now: number = Date.now()): number {
  const days = (now - node.lastReviewedAt) / 86400000;
  return node.confidence * Math.pow(2, -days / node.halfLifeDays);
}

/**
 * Determines if a node is due for review based on its retention score.
 * Mirrors the browser-side formula in dashboard/dag-blackboard.js.
 * 
 * @param node - The node to check for review.
 * @param threshold - The threshold below which the node is due for review.
 * @param now - The current timestamp in milliseconds since epoch.
 * @returns True if the node is due for review, false otherwise.
 */
export function isDueForReview(node: { confidence: number; lastReviewedAt: number; halfLifeDays: number }, threshold = 0.5, now: number = Date.now()): boolean {
  return retentionOf(node, now) < threshold;
}
