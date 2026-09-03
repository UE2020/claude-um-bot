// Detecting when someone is talking to us, mentioning our role, or speaking in mafia chat.
//
// Being addressed or seeing updates in mafia chat are events we can't afford to notice late.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Common abbreviations and aliases used on UltiMafia for roles.
 */
const ROLE_ALIASES = {
  "Town Crier": ["crier", "tc", "town crier", "cry out", "cries out", "cry"],
  "Crier": ["crier", "tc", "cry out", "cries out", "cry"],
  "Oracle": ["oracle", "orc", "orc claim", "oracle claim"],
  "Caroler": ["caroler", "carol", "caroled", "sing carol"],
  "Cop": ["cop", "cop check", "cop result"],
  "Sheriff": ["sheriff", "gun", "shot"],
  "Doctor": ["doc", "doctor", "save"],
  "Hooker": ["hooker", "hook", "hooked", "rb", "roleblock"],
  "Janitor": ["jan", "janitor", "janned", "clean"],
  "Mafioso": ["mafioso"],
  "Godfather": ["godfather", "gf"],
  "Tracker": ["tracker", "track"],
  "Watcher": ["watcher", "watch"],
  "Stalker": ["stalker", "stalk"],
  "Villager": ["blue", "villager"],
};

/**
 * Build regex patterns for a given role name.
 */
export function buildRolePatterns(roleName) {
  if (!roleName) return [];
  const baseName = String(roleName).split(":")[0].trim();
  const aliases = ROLE_ALIASES[baseName] || [baseName.toLowerCase()];
  return aliases.map((alias) => `\\b${escapeRegex(alias)}\\b`);
}

/**
 * Players shorten names: "JimmieBathsheba22" becomes Jimmie, Jimmy, Jimm or
 * Bathsheba in chat. Split the name into its camel-case / non-letter parts
 * and match the first four letters of each part as a word prefix. Parts
 * shorter than four letters are skipped so "DetectiveBob" does not wake on
 * every "bob".
 */
export function nameVariantPatterns(playerName) {
  const words = String(playerName || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length >= 4);
  return [...new Set(words.map((w) => `\\b${escapeRegex(w.slice(0, 4).toLowerCase())}[a-z]*`))];
}

/**
 * Matches the account name anywhere, plus "claude" as a standalone word so
 * "@claude", "claude?" and "Claude," all count. Dynamically includes the
 * live in-game player name and its likely abbreviations if provided.
 */
export function buildMentionRegex(config = {}, playerName = null) {
  const set = new Set();

  if (config.mentionPatterns?.length) {
    for (const p of config.mentionPatterns) set.add(escapeRegex(p));
  } else {
    set.add("claudebyanthropic");
    set.add("\\bclaude\\b");
  }

  if (playerName) {
    const trimmed = String(playerName).trim();
    if (trimmed) {
      set.add(escapeRegex(trimmed));
      set.add(`\\b${escapeRegex(trimmed)}\\b`);
      for (const p of nameVariantPatterns(trimmed)) set.add(p);
    }
  }

  return new RegExp([...set].join("|"), "i");
}

/**
 * Chat that names us AND pushes against us. Site shorthand is compact
 * enough that a word list catches most of it; the agent decides what to do.
 */
const HOSTILE_REGEX =
  /\b(fos|scum|scummy|sus|sussy|lynch|hang|condemn|vote|voting|omgus|blatant|maf|mafia|liar|lying|lied|fake|wagon|hammer|kill|shoot|yeet|exe|throwing|wolf|wolfy)\b/i;

export function isHostile(content) {
  return HOSTILE_REGEX.test(String(content || ""));
}

/**
 * Server-authored lines worth waking for: a gun going off, a death or flip,
 * or a report. Returns a short kind label, or null for lore/noise.
 */
export function classifySystemMessage(content) {
  const text = String(content || "");
  if (/\b(gun|gunshot|shot|shoots|shooting)\b/i.test(text)) return "gunshot";
  if (/\b(died|dies|killed|dead|death|condemned|lynched|executed|hanged|was an?|were an?)\b/i.test(text)) return "death";
  if (/\b(report|result|innocent|guilty|visited|visit|learn|learned|discover|tracked|watched)\b/i.test(text)) return "report";
  return null;
}

/**
 * Checks if a message is a private whisper addressed to self.
 * In UM, whispered messages carry prefix: "whispers to <PlayerName>".
 */
export function isWhisperToSelf(message, { selfId, selfName }) {
  if (!message || message.senderId === selfId || message.senderId === "server") return false;
  const prefix = String(message.prefix || "").toLowerCase();
  if (!prefix.includes("whispers to")) return false;

  if (selfName && prefix.includes(String(selfName).toLowerCase())) return true;
  if (selfId && prefix.includes(String(selfId).toLowerCase())) return true;
  return false;
}

/**
 * Regex detecting conversational follow-up triggers (questions, clarification slang, second-person references).
 */
const CONVERSATIONAL_QUESTION_REGEX =
  /\b(wdym|wym|wby|why|what|wat|wut|how|who|whom|when|where|explain|elaborate|clarify|mean|meaning|huh|wait|wait what|hold on|rly|really|sure|fr|cap|capping|sus|fake|lies|liar|agree|disagree|proof|source|reason|thoughts|thought)\b/i;

const SECOND_PERSON_REGEX = /\b(you|u|your|ur|you're|youre|ure|yours)\b/i;

/**
 * Checks if an incoming message is a conversational follow-up to our last sent message.
 */
export function isConversationalReply(message, { lastSpoke, messagesSinceSpoke = 0, memberCount = 10 } = {}) {
  if (!message) return false;
  if (lastSpoke && message.senderId === lastSpoke.senderId) return false;
  if (message.senderId === "server") return false;

  const content = String(message.content || "").trim();
  if (!content) return false;

  // 1-on-1 private meeting (e.g. Jailor cell, direct whisper meeting):
  // Any message from the other person is a direct address!
  if (memberCount <= 2) return true;

  if (!lastSpoke || !lastSpoke.time) return false;

  // Must be in the same meeting where we spoke.
  if (lastSpoke.meetingId && message.meetingId && String(lastSpoke.meetingId) !== String(message.meetingId)) {
    return false;
  }

  const timeElapsed = (message.time || Date.now()) - lastSpoke.time;
  // Conversational reply window: within 45 seconds and at most 1 intervening message.
  if (timeElapsed > 45000 || messagesSinceSpoke > 1) return false;

  // Question mark is the strongest conversational cue.
  if (content.includes("?")) return true;

  // Conversational question / clarification starters.
  if (CONVERSATIONAL_QUESTION_REGEX.test(content)) return true;

  // Second-person reference when speaking right after us (e.g. "are you sure", "u vote first").
  if (messagesSinceSpoke === 0 && SECOND_PERSON_REGEX.test(content)) return true;

  // In small meetings (<= 4 players, e.g. Mafia chat), immediate next message is very likely addressing us.
  if (memberCount <= 4 && messagesSinceSpoke === 0 && timeElapsed <= 30000) return true;

  return false;
}

/**
 * Classifies an incoming message to determine if it addresses the bot,
 * returning the address type, reason, and conversational context if applicable.
 */
export function classifyIncomingMessage(message, ctx = {}) {
  const {
    regex,
    roleRegex,
    selfId,
    selfName,
    lastSpoke,
    messagesSinceSpoke = 0,
    memberCount = 10,
    meetings = {},
    getMessage = null,
  } = ctx;

  if (!message || message.senderId === selfId || message.senderId === "server") {
    return { isAddressed: false, type: null, reason: "" };
  }

  // 1. Direct whisper to self
  if (isWhisperToSelf(message, { selfId, selfName })) {
    return {
      isAddressed: true,
      type: "whisper",
      reason: "Private whisper to you",
      replyTo: message.prefix,
    };
  }

  // 2. Direct quote of our message
  if (message.isQuote || (message.messageId && getMessage)) {
    const original = getMessage ? getMessage(message.messageId) : null;
    if (original && original.senderId === selfId) {
      return {
        isAddressed: true,
        type: "quote",
        reason: "Quoted your message",
        replyTo: original.content,
      };
    }
  }

  // 3. Explicit name mention
  if (regex && regex.test(message.content)) {
    return {
      isAddressed: true,
      type: "mention",
      reason: "Named you in chat",
    };
  }

  // 4. Role mention (e.g. "cop claim", "crier cry")
  if (roleRegex && roleRegex.test(message.content)) {
    return {
      isAddressed: true,
      type: "role",
      reason: "Mentioned your role",
    };
  }

  // 5. Conversational reply to our recent message
  if (isConversationalReply(message, { lastSpoke, messagesSinceSpoke, memberCount })) {
    return {
      isAddressed: true,
      type: "reply",
      reason: "Conversational reply/question to your line",
      replyTo: lastSpoke?.content,
    };
  }

  // 6. Faction chat update (Mafia night chat, etc.)
  if (isFactionMessage(message, { meetings, selfId })) {
    return {
      isAddressed: true,
      type: "faction",
      reason: "Message in faction chat",
    };
  }

  return { isAddressed: false, type: null, reason: "" };
}

/**
 * True when `message` is someone addressing us or mentioning our role.
 * Backward-compatible wrapper over classifyIncomingMessage.
 */
export function isMention(message, ctx = {}) {
  const result = classifyIncomingMessage(message, ctx);
  return result.isAddressed;
}

/**
 * True when a message is received in a faction chat meeting (e.g. "Mafia Meeting", "Cult Meeting").
 */
export function isFactionMessage(message, { meetings, selfId }) {
  if (!message || message.senderId === selfId || message.senderId === "server") return false;
  const meeting = meetings?.[message.meetingId];
  if (!meeting) return false;
  const name = meeting.name || "";
  return /mafia|cult|mason|coven|werewolf|vampire/i.test(name);
}
