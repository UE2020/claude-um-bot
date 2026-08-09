// Detecting when someone is talking to us.
//
// Being addressed is the one event we can't afford to notice late, since
// otherwise it's only picked up on the next poll.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the account name anywhere, plus "claude" as a standalone word so
 * "@claude", "claude?" and "Claude," all count. `\bclaude\b` alone would miss
 * "ClaudeByAnthropic" — there's no word boundary before the "B" — so both
 * patterns are needed. Override via `mentionPatterns` in config.json (those
 * are treated as literals, not regexes).
 */
export function buildMentionRegex(config = {}) {
  const patterns = config.mentionPatterns?.length
    ? config.mentionPatterns.map(escapeRegex)
    : ["claudebyanthropic", "\\bclaude\\b"];
  return new RegExp(patterns.join("|"), "i");
}

/**
 * True when `message` is someone addressing us. Our own messages are excluded,
 * and so are server lines — "ClaudeByAnthropic is ready." carries the name but
 * nobody is talking to us.
 */
export function isMention(message, { regex, selfId }) {
  if (!message || typeof message.content !== "string") return false;
  if (message.senderId === selfId) return false;
  if (message.senderId === "server") return false;
  return regex.test(message.content);
}
