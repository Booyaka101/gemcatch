'use strict';

/**
 * Interaction lifecycle states.
 *
 * These mirror the InteractionStatus union in @google/genai
 * (dist/genai.d.ts): "in_progress" | "requires_action" | "completed" |
 * "failed" | "cancelled" | "incomplete" | "budget_exceeded".
 *
 * "pending" is ours alone: a row exists locally but the submit call has not
 * come back yet, so there is no interaction_id to poll.
 */

const PENDING = 'pending';

// Reached a final state. Polling one of these again tells you nothing new.
const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled', 'incomplete', 'budget_exceeded']);

// Still moving. `gemcatch sync` refreshes exactly these.
const ACTIVE = Object.freeze(['in_progress', 'requires_action']);

const TERMINAL_SET = new Set(TERMINAL);

function isDone(status) {
  return TERMINAL_SET.has(status);
}

// Did the task finish with something worth reading?
function isSuccess(status) {
  return status === 'completed';
}

module.exports = { PENDING, TERMINAL, ACTIVE, isDone, isSuccess };
