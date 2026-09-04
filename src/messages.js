// Message visibility helpers shared by live rendering and archive replay.

/** Archived review history preserves the real sender id for Cry messages. */
export function isCryMessage(message) {
  return /^cries out$/i.test(String(message?.prefix || "").trim());
}

/** Sender id that a player is actually allowed to see. */
export function visibleSenderId(message) {
  return message?.senderId === "anonymous" || isCryMessage(message)
    ? "anonymous"
    : message?.senderId;
}

/** Clone only when an archive message needs its hidden sender removed. */
export function withVisibleSender(message) {
  const senderId = visibleSenderId(message);
  return senderId === message?.senderId ? message : { ...message, senderId };
}
