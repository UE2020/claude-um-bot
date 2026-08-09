// Offline tests for meeting/target resolution — the logic that decides what
// actually gets put on the wire. Run: node test/resolve.test.mjs
import assert from "node:assert/strict";
import { GameState } from "../src/state.js";
import { stringifyMessage, parseMessage } from "../src/wire.js";
import { buildMentionRegex, isMention } from "../src/mentions.js";

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
}

console.log(`\n${passed} passed`);
