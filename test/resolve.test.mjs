// Offline tests for meeting/target resolution — the logic that decides what
// actually gets put on the wire. Run: node test/resolve.test.mjs
import assert from "node:assert/strict";
import { GameState } from "../src/state.js";
import { stringifyMessage, parseMessage } from "../src/wire.js";
import {
  buildMentionRegex,
  buildRolePatterns,
  classifyIncomingMessage,
  isMention,
  isFactionMessage,
  isWhisperToSelf,
  isConversationalReply,
  nameVariantPatterns,
  isHostile,
  classifySystemMessage,
} from "../src/mentions.js";
import { renderState, renderCompactState, calculateParity } from "../src/render.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

function makeState() {
  const s = new GameState("test");
  s.selfId = "me";
  s.players = {
    me: { id: "me", name: "ClaudeByAnthropic", playerListPosition: 0 },
    a: { id: "a", name: "Alice", playerListPosition: 1 },
    b: { id: "b", name: "Bob", playerListPosition: 2 },
    c: { id: "c", name: "Bobby", playerListPosition: 3 },
    d: { id: "d", name: "Dave", playerListPosition: 4, left: true },
  };
  s.meetings = {
    m1: {
      id: "m1",
      name: "Village",
      actionName: "Vote to Condemn",
      voting: true,
      speech: true,
      canVote: true,
      canTalk: true,
      amMember: true,
      inputType: "player",
      targets: ["a", "b", "c", "*"],
      votes: {},
    },
    m2: {
      id: "m2",
      name: "Mafia Kill",
      actionName: "Mafia Kill",
      voting: true,
      canVote: true,
      amMember: true,
      inputType: "player",
      targets: ["a", "b"],
      votes: {},
    },
    m3: {
      id: "m3",
      name: "Mafia Action",
      actionName: "End Meeting?",
      voting: true,
      canVote: true,
      amMember: true,
      inputType: "boolean",
      targets: ["Yes", "No"],
      votes: {},
    },
  };
  return s;
}

console.log("wire framing");
test("round-trips an object", () => {
  const [name, data] = parseMessage(stringifyMessage("vote", { meetingId: "m1", selection: "a" }));
  assert.equal(name, "vote");
  assert.deepEqual(data, { meetingId: "m1", selection: "a" });
});
test("payload containing colons survives", () => {
  const [, data] = parseMessage(stringifyMessage("speak", { content: "12:30 sounds good" }));
  assert.equal(data.content, "12:30 sounds good");
});
test("bare event has no payload", () => {
  assert.equal(stringifyMessage("p"), "p");
  assert.deepEqual(parseMessage("p"), ["p", undefined]);
});
test("booleans and numbers keep their type", () => {
  assert.equal(parseMessage(stringifyMessage("isStarted", false))[1], false);
  assert.equal(parseMessage(stringifyMessage("time", 42))[1], 42);
});

console.log("\ntarget resolution");
test("resolves an exact player name to its id", () => {
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m1, "Alice"), { target: "a" });
});
test("name match is case-insensitive", () => {
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m1, "alice"), { target: "a" });
});
test("exact name wins over a longer prefix match", () => {
  // "Bob" is a prefix of "Bobby"; the exact name must not be ambiguous.
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m1, "Bob"), { target: "b" });
});
test("genuinely ambiguous prefix is rejected", () => {
  const s = makeState();
  const r = s.resolveTarget(s.meetings.m1, "Bob");
  assert.equal(r.target, "b");
  const r2 = s.resolveTarget(s.meetings.m1, "Bobb");
  assert.equal(r2.target, "c");
});
test("'no one' maps to the abstain target", () => {
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m1, "no one"), { target: "*" });
});
test("abstain rejected when the meeting forbids it", () => {
  const s = makeState();
  const r = s.resolveTarget(s.meetings.m2, "skip");
  assert.ok(r.error, "expected an error");
});
test("illegal-but-real player is rejected with the legal list", () => {
  const s = makeState();
  const r = s.resolveTarget(s.meetings.m2, "Bobby"); // not in m2.targets
  assert.ok(r.error);
  assert.match(r.error, /not a legal target/);
});
test("unknown name is rejected", () => {
  const s = makeState();
  assert.ok(s.resolveTarget(s.meetings.m1, "Nobody").error);
});
test("boolean meetings accept Yes/No case-insensitively", () => {
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m3, "yes"), { target: "Yes" });
});
test("player ids pass through", () => {
  const s = makeState();
  assert.deepEqual(s.resolveTarget(s.meetings.m1, "a"), { target: "a" });
});

console.log("\nmeeting resolution");
test("ambiguous with no hint", () => {
  const s = makeState();
  assert.ok(s.resolveMeeting(null, s.votableMeetings()).error);
});
test("unique when only one is votable", () => {
  const s = makeState();
  delete s.meetings.m2;
  delete s.meetings.m3;
  assert.equal(s.resolveMeeting(null, s.votableMeetings()).meeting.id, "m1");
});
test("matches by substring, case-insensitively", () => {
  const s = makeState();
  assert.equal(s.resolveMeeting("kill", s.votableMeetings()).meeting.id, "m2");
});
test("exact name wins over substring", () => {
  // "Mafia Action" and "Mafia Kill" both contain "Mafia".
  const s = makeState();
  assert.equal(s.resolveMeeting("Mafia Action", s.votableMeetings()).meeting.id, "m3");
  assert.ok(s.resolveMeeting("Mafia", s.votableMeetings()).error);
});
test("meetings you cannot vote in are excluded", () => {
  const s = makeState();
  s.meetings.m1.canVote = false;
  assert.ok(s.resolveMeeting("Village", s.votableMeetings()).error);
});

console.log("\nstate fold");
test("history seeds meetings, later same-state event keeps them", () => {
  const s = new GameState("g");
  s.apply("history", {
    "-1": { name: "Pregame", meetings: { x: { id: "x", name: "Pregame" } }, alerts: [], roles: {}, dead: {} },
  });
  s.apply("state", { name: "Pregame", id: -1, dayCount: 0 });
  assert.ok(s.meetings.x, "meeting survived the same-state event");
});
test("a real phase change clears stale meetings", () => {
  const s = new GameState("g");
  s.meetings = { x: { id: "x", name: "Village" } };
  s.apply("state", { name: "Night", id: 1, dayCount: 1 });
  assert.deepEqual(s.meetings, {});
  assert.equal(s.phaseLabel, "Night 1");
});
test("payload-less isStarted is not read as true", () => {
  const s = new GameState("g");
  s.apply("isStarted", undefined);
  assert.equal(s.started, false);
});
test("death broadcasts update the dead map live", () => {
  const s = new GameState("g");
  s.players = { a: { id: "a", name: "Alice" } };
  s.apply("death", "a");
  assert.equal(s.deadMap().a, true);
  assert.equal(s.alivePlayers().length, 0);
});
test("messages dedupe across history and live events", () => {
  const s = new GameState("g");
  const msg = { id: "m", senderId: "server", content: "Alice is innocent.", time: 1 };
  s.apply("message", msg);
  s.apply("message", msg);
  assert.equal(s.systemMessages().length, 1);
});

console.log("\nmention detection");
{
  const regex = buildMentionRegex({});
  const ctx = { regex, selfId: "me" };
  const from = (senderId, content) => ({ senderId, content });

  const wakes = [
    "@ClaudeByAnthropic what do you have?",
    "claude, cop check?",
    "@claude",
    "Claude",
    "what does CLAUDE think",
    "claude?",
    "(claude)",
    "claudebyanthropic is sus",
    "vote claude",
  ];
  for (const text of wakes) {
    test(`wakes on ${JSON.stringify(text)}`, () =>
      assert.equal(isMention(from("a", text), ctx), true));
  }

  const ignores = ["im clauding around", "applause for the town", "no one here", "claudia said so"];
  for (const text of ignores) {
    test(`ignores ${JSON.stringify(text)}`, () =>
      assert.equal(isMention(from("a", text), ctx), false));
  }

  test("ignores our own messages", () =>
    assert.equal(isMention(from("me", "claude here"), ctx), false));
  test("ignores server lines naming us", () =>
    assert.equal(isMention(from("server", "ClaudeByAnthropic is ready."), ctx), false));
  test("ignores messages with no content", () =>
    assert.equal(isMention({ senderId: "a" }, ctx), false));
  test("honours custom patterns from config", () => {
    const custom = { regex: buildMentionRegex({ mentionPatterns: ["botty"] }), selfId: "me" };
    assert.equal(isMention(from("a", "hey botty"), custom), true);
    assert.equal(isMention(from("a", "hey claude"), custom), false);
  });

  test("wakes on role mention for Town Crier (tc / crier)", () => {
    const rolePatterns = buildRolePatterns("Town Crier:Armed/Covert");
    const roleRegex = new RegExp(rolePatterns.join("|"), "i");
    const ctx = { regex: buildMentionRegex({}), selfId: "me", roleRegex };
    assert.equal(isMention(from("a", "shoot with tc"), ctx), true);
    assert.equal(isMention(from("a", "crier out now"), ctx), true);
    assert.equal(isMention(from("a", "someone cries out"), ctx), true);
    assert.equal(isMention(from("a", "random chatter"), ctx), false);
  });

  test("wakes on role mention for Oracle (orc / oracle / orc claim)", () => {
    const rolePatterns = buildRolePatterns("Oracle:Astral/Resolute");
    const roleRegex = new RegExp(rolePatterns.join("|"), "i");
    const ctx = { regex: buildMentionRegex({}), selfId: "me", roleRegex };
    assert.equal(isMention(from("a", "orc claim please"), ctx), true);
    assert.equal(isMention(from("a", "who is the oracle"), ctx), true);
    assert.equal(isMention(from("a", "random chatter"), ctx), false);
  });

  test("wakes on role mention for Caroler (caroler / carol)", () => {
    const rolePatterns = buildRolePatterns("Caroler");
    const roleRegex = new RegExp(rolePatterns.join("|"), "i");
    const ctx = { regex: buildMentionRegex({}), selfId: "me", roleRegex };
    assert.equal(isMention(from("a", "did anyone get caroled"), ctx), true);
    assert.equal(isMention(from("a", "who is caroler"), ctx), true);
    assert.equal(isMention(from("a", "random chatter"), ctx), false);
  });

  test("detects faction/mafia chat messages", () => {
    const meetings = {
      m_maf: { id: "m_maf", name: "Mafia Meeting" },
      m_vil: { id: "m_vil", name: "Village" },
      m_cult: { id: "m_cult", name: "Cult Meeting" },
    };
    const ctx = { meetings, selfId: "me" };
    assert.equal(isFactionMessage({ senderId: "partner", meetingId: "m_maf", content: "kill alice" }, ctx), true);
    assert.equal(isFactionMessage({ senderId: "partner", meetingId: "m_cult", content: "convert bob" }, ctx), true);
    assert.equal(isFactionMessage({ senderId: "partner", meetingId: "m_vil", content: "hi all" }, ctx), false);
    assert.equal(isFactionMessage({ senderId: "me", meetingId: "m_maf", content: "kill bob" }, ctx), false);
    assert.equal(isFactionMessage({ senderId: "server", meetingId: "m_maf", content: "night starts" }, ctx), false);
  });
}

console.log("\nspeech abilities framing");
{
  test("frames speak with abilityName and abilityTarget", () => {
    const payload = {
      meetingId: "m1",
      content: "BW Alice",
      abilityName: "Cry",
      abilityTarget: "out",
    };
    const frame = stringifyMessage("speak", payload);
    const [event, parsed] = parseMessage(frame);
    assert.equal(event, "speak");
    assert.equal(parsed.meetingId, "m1");
    assert.equal(parsed.content, "BW Alice");
    assert.equal(parsed.abilityName, "Cry");
    assert.equal(parsed.abilityTarget, "out");
  });
}

console.log("\nconversational reply and address classification");
{
  const selfId = "me";
  const selfName = "ClaudeByAnthropic";
  const now = 1000000;
  const lastSpoke = {
    time: now,
    meetingId: "m1",
    content: "I think Bob is mafia because of his push on Alice",
    senderId: selfId,
  };

  test("classifies 'wait wdym by X' as a reply to recent message", () => {
    const msg = {
      senderId: "alice",
      meetingId: "m1",
      content: "wait wdym by X",
      time: now + 5000,
    };
    const res = classifyIncomingMessage(msg, {
      selfId,
      selfName,
      lastSpoke,
      messagesSinceSpoke: 0,
      memberCount: 7,
    });
    assert.equal(res.isAddressed, true);
    assert.equal(res.type, "reply");
    assert.equal(res.replyTo, lastSpoke.content);
  });

  test("classifies questions and second-person references as replies", () => {
    const wakes = [
      "why Bob though?",
      "are you sure?",
      "what are u talking about",
      "wdym?",
      "explain please",
      "cap",
      "lies",
    ];
    for (const text of wakes) {
      const msg = { senderId: "alice", meetingId: "m1", content: text, time: now + 4000 };
      const res = classifyIncomingMessage(msg, {
        selfId,
        selfName,
        lastSpoke,
        messagesSinceSpoke: 0,
        memberCount: 7,
      });
      assert.equal(res.isAddressed, true, `expected wake on "${text}"`);
      assert.equal(res.type, "reply");
    }
  });

  test("ignores unrelated messages after conversational timeout (>45s)", () => {
    const msg = {
      senderId: "alice",
      meetingId: "m1",
      content: "who wants pizza tonight?",
      time: now + 60000,
    };
    const res = classifyIncomingMessage(msg, {
      selfId,
      selfName,
      lastSpoke,
      messagesSinceSpoke: 0,
      memberCount: 7,
    });
    assert.equal(res.isAddressed, false);
  });

  test("ignores chatter when multiple messages have intervened", () => {
    const msg = {
      senderId: "dave",
      meetingId: "m1",
      content: "why did that happen?",
      time: now + 10000,
    };
    const res = classifyIncomingMessage(msg, {
      selfId,
      selfName,
      lastSpoke,
      messagesSinceSpoke: 3, // 3 other messages in between
      memberCount: 7,
    });
    assert.equal(res.isAddressed, false);
  });

  test("1-on-1 private meetings treat any message as a direct address", () => {
    const msg = {
      senderId: "jailor",
      meetingId: "m_cell",
      content: "claim now",
      time: now + 1000,
    };
    const res = classifyIncomingMessage(msg, {
      selfId,
      selfName,
      lastSpoke: null,
      messagesSinceSpoke: 0,
      memberCount: 2,
    });
    assert.equal(res.isAddressed, true);
    assert.equal(res.type, "reply");
  });

  test("detects whisper to self", () => {
    const msg = {
      senderId: "bob",
      meetingId: "m1",
      prefix: "whispers to ClaudeByAnthropic",
      content: "who is innocent?",
      time: now + 2000,
    };
    const res = classifyIncomingMessage(msg, { selfId, selfName });
    assert.equal(res.isAddressed, true);
    assert.equal(res.type, "whisper");
  });

  test("ignores whisper to someone else", () => {
    const msg = {
      senderId: "bob",
      meetingId: "m1",
      prefix: "whispers to Alice",
      content: "hey",
      time: now + 2000,
    };
    assert.equal(isWhisperToSelf(msg, { selfId, selfName }), false);
  });

  test("detects quote of self message", () => {
    const messages = new Map([
      ["msg1", { id: "msg1", senderId: selfId, content: "I'm the Cop" }],
    ]);
    const msg = {
      senderId: "alice",
      meetingId: "m1",
      isQuote: true,
      messageId: "msg1",
      content: "[quoting ClaudeByAnthropic] \"I'm the Cop\"",
      time: now + 3000,
    };
    const res = classifyIncomingMessage(msg, {
      selfId,
      selfName,
      getMessage: (id) => messages.get(id),
    });
    assert.equal(res.isAddressed, true);
    assert.equal(res.type, "quote");
    assert.equal(res.replyTo, "I'm the Cop");
  });

  test("dynamic player name mention matches in-game alias", () => {
    const regex = buildMentionRegex({}, "DetectiveBob");
    const ctx = { regex, selfId: "me" };
    assert.equal(isMention({ senderId: "a", content: "DetectiveBob is inno" }, ctx), true);
    assert.equal(isMention({ senderId: "a", content: "@DetectiveBob" }, ctx), true);
    assert.equal(isMention({ senderId: "a", content: "vote detectivebob" }, ctx), true);
    assert.equal(isMention({ senderId: "a", content: "who is bob?" }, ctx), false);
  });

  test("name variants: players shorten JimmieBathsheba22 to jimmy / jimm / bathsheba", () => {
    assert.deepEqual(nameVariantPatterns("JimmieBathsheba22"), ["\\bjimm[a-z]*", "\\bbath[a-z]*"]);
    const regex = buildMentionRegex({}, "JimmieBathsheba22");
    const ctx = { regex, selfId: "me" };
    for (const text of ["jimmy?", "Jimm u there", "@Jimmie vote", "bathsheba is scum", "JIMMY IS BLATANT"]) {
      assert.equal(isMention({ senderId: "a", content: text }, ctx), true, text);
    }
    for (const text of ["jim is fine", "slim jims", "nothing here"]) {
      assert.equal(isMention({ senderId: "a", content: text }, ctx), false, text);
    }
    assert.deepEqual(nameVariantPatterns("Bob"), []);
  });

  test("hostile shorthand is flagged, neutral pings are not", () => {
    for (const text of ["fos jimmy", "jimmy is scum", "vote jimm", "i omgus u", "jimmie blatant lol", "u r sus"]) {
      assert.equal(isHostile(text), true, text);
    }
    for (const text of ["jimmy what do you think", "jimm any reads?", "hi jimmie"]) {
      assert.equal(isHostile(text), false, text);
    }
  });

  test("system messages that matter are classified, lore is not", () => {
    assert.equal(classifySystemMessage("A gunshot rings out! Alice shot Bob."), "gunshot");
    assert.equal(classifySystemMessage("Bob was condemned. Bob was a Villager."), "death");
    assert.equal(classifySystemMessage("You learn that Alice is innocent."), "report");
    assert.equal(classifySystemMessage("The sun rises on a new day."), null);
    assert.equal(classifySystemMessage(""), null);
  });
}

console.log("\ncompact state rendering and parity calculation");
{
  test("calculates parity correctly", () => {
    const s = makeState();
    s.started = true;
    s.setup = { total: 5, roles: [{ Cop: 1, "Mafia Goon": 2, Villager: 2 }] };
    const mockKnowledge = {
      alignmentCounts: () => ({ Mafia: 2, Town: 3 }),
      role: (r) => (r === "Mafia Goon" ? { alignment: "Mafia" } : { alignment: "Town" }),
    };
    const parity = calculateParity(s, mockKnowledge);
    assert.ok(parity);
    assert.equal(parity.aliveCount, 4); // me, a, b, c (d left)
    assert.equal(parity.estimatedAliveMafia, 2);
    assert.equal(parity.miscondemns, 0);
    assert.match(parity.status, /LYLO/);
    assert.ok(parity.warning);
  });

  test("compact state is substantially smaller than full state", () => {
    const s = makeState();
    s.started = true;
    s.history = { 1: { roles: { me: "Cop" } } };
    s.setup = { name: "Test Setup", total: 5, roles: [{ Cop: 1, "Mafia Goon": 1, Villager: 3 }] };
    const mockKnowledge = {
      startState: () => "Day",
      describe: (r) => `Role description for ${r} with lots of text...\n`.repeat(10),
      alignmentCounts: () => ({ Mafia: 1, Town: 4 }),
      role: () => ({ alignment: "Town", category: "Investigative", description: "Long text...", nightOrder: [] }),
      noteLines: () => [],
      modifier: () => null,
    };

    const full = renderState(s, mockKnowledge);
    const compact = renderCompactState(s, mockKnowledge);

    assert.ok(compact.includes("[COMPACT]"));
    assert.ok(compact.includes("Alive (4):"));
    assert.ok(compact.length < full.length * 0.6, `compact length ${compact.length} should be < 60% of full ${full.length}`);
  });

  test("renders exact delta messages when provided", () => {
    const s = makeState();
    const mockKnowledge = { alignmentCounts: () => ({}), role: () => null };
    const delta = [
      { id: "1", senderId: "a", content: "first new message", time: 1000 },
      { id: "2", senderId: "b", content: "second new message", time: 2000 },
    ];
    const res = renderCompactState(s, mockKnowledge, {
      messages: delta,
      chatLabel: "2 new since last check",
    });
    assert.ok(res.includes("── CHAT (2 new since last check) ──────────────────────────"));
    assert.ok(res.includes("Alice: first new message"));
    assert.ok(res.includes("Bob: second new message"));
  });

  test("renders (no new messages) when delta is empty", () => {
    const s = makeState();
    const mockKnowledge = { alignmentCounts: () => ({}), role: () => null };
    const res = renderCompactState(s, mockKnowledge, {
      messages: [],
      chatLabel: "0 new since last check",
    });
    assert.ok(res.includes("── CHAT (0 new since last check) ──────────────────────────"));
    assert.ok(res.includes("(no new messages)"));
  });

  test("archive Cry messages never reveal their real sender", () => {
    const s = makeState();
    const mockKnowledge = { alignmentCounts: () => ({}), role: () => null };
    s.meetings.m1.speechAbilities = [
      { name: "Cry", targets: ["out"], targetType: "out" },
    ];
    s.addMessage({
      id: "cry-1",
      senderId: "a",
      content: "remember the claim order",
      prefix: "cries out",
      meetingId: "day",
      time: 1000,
    });
    const stored = s.messages.get("cry-1");
    assert.equal(stored.senderId, "anonymous");
    const res = renderCompactState(s, mockKnowledge, { chatLimit: 10 });
    assert.ok(res.includes("Anonymous (cries out): remember the claim order"));
    assert.ok(!res.includes("Alice (cries out)"));
    assert.ok(res.includes('um cry "<text>" --meeting "Village"'));
  });
}

console.log(`\n${passed} passed`);
