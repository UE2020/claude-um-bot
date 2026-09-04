// Offline tests for the local-model harness: decision validation and prompt
// assembly, the code that stands between a small model and the wire.
// Run: node test/agent.test.mjs
import assert from "node:assert/strict";
import {
  validateDecision,
  legalActionsBlock,
  buildTurnPrompt,
  quotesSystemMessage,
  sanitiseChat,
  parseDecision,
  cryableMeetings,
  speechRequestBody,
  timeLeft,
} from "../src/agent.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

function fixture() {
  return {
    selfId: "p2",
    players: {
      p1: { id: "p1", name: "alice" },
      p2: { id: "p2", name: "bob" },
      p3: { id: "p3", name: "carol" },
    },
    meetings: {
      m1: {
        id: "m1", name: "Village", amMember: true, voting: true, canVote: true,
        speech: true, canTalk: true, targets: ["p1", "p3", "*"], votes: { p1: "p3" },
      },
      m2: {
        id: "m2", name: "Mafia", amMember: true, voting: false, canVote: false,
        speech: true, canTalk: true, targets: [],
      },
      m3: {
        id: "m3", name: "Secret", amMember: false, voting: true, canVote: true,
        speech: true, canTalk: true, targets: ["p1"],
      },
    },
    messages: [
      { senderId: "server", content: "alice was attacked by the Mafia and has died. alice was a Cop." },
      { senderId: "p1", content: "vote carol" },
    ],
  };
}

test("legal actions list only meetings we are a member of", () => {
  const block = legalActionsBlock(fixture());
  assert.match(block, /VOTE "Village": targets = alice, carol, No One; yours = \(not cast\)/);
  assert.match(block, /SAY "Village"/);
  assert.match(block, /SAY "Mafia"/);
  assert.doesNotMatch(block, /Secret/);
});

test("legal actions falls back to wait when nothing is actionable", () => {
  const raw = fixture();
  raw.meetings = {};
  assert.match(legalActionsBlock(raw), /use wait/);
});

test("Cry is listed only where the player has the anonymous speech ability", () => {
  const raw = fixture();
  raw.meetings.m1.speechAbilities = [
    { name: "Cry", targets: ["out"], targetType: "out" },
  ];
  const block = legalActionsBlock(raw);
  assert.match(block, /CRY "Village" \(anonymous broadcast\)/);
  assert.doesNotMatch(block, /CRY "Mafia"/);
  assert.deepEqual(cryableMeetings(raw).map((m) => m.name), ["Village"]);
});

test("say defaults to the Village meeting when the model leaves it blank", () => {
  const v = validateDecision({ action: "say", text: "leaning carol" }, fixture());
  assert.equal(v.ok, true);
  assert.equal(v.meeting, "Village");
  assert.equal(v.text, "leaning carol");
});

test("say resolves a partial meeting name", () => {
  const v = validateDecision({ action: "say", meeting: "maf", text: "kill alice?" }, fixture());
  assert.equal(v.ok, true);
  assert.equal(v.meeting, "Mafia");
});

test("cry requires a listed Cry ability and dispatches it anonymously", () => {
  const raw = fixture();
  const unavailable = validateDecision({ action: "cry", text: "test" }, raw);
  assert.equal(unavailable.ok, false);

  raw.meetings.m1.speechAbilities = [
    { name: "Cry", targets: ["out"], targetType: "out" },
  ];
  const v = validateDecision({ action: "cry", text: "still watching" }, raw);
  assert.deepEqual(v, {
    ok: true,
    action: "cry",
    meeting: "Village",
    text: "still watching",
    texts: ["still watching"],
  });
  assert.deepEqual(speechRequestBody(v.action, v.meeting, v.text), {
    meeting: "Village",
    text: "still watching",
    ability: "Cry",
    abilityTarget: "out",
  });
});

test("say strips markdown and caps an unbreakable line at 240 characters", () => {
  const long = "**hi**  there\n\n" + "x".repeat(300);
  const v = validateDecision({ action: "say", text: long }, fixture());
  assert.equal(v.ok, true);
  assert.equal(v.texts[0], "hi there");
  assert.ok(v.texts[1].length <= 240);
});

test("a long paragraph is broken into lines at sentence ends, each under 180", () => {
  const para =
    "alright so bob is quiet and alice wants him out, but i think it's time to talk about me since dave and carol asked. " +
    "i'm erin, a villager with no special info yet. i haven't said much because i was listening. what do you guys think? should we wait for a flip?";
  const v = validateDecision({ action: "say", text: para }, fixture(), { maxLines: 3 });
  assert.equal(v.ok, true);
  assert.ok(v.texts.length >= 2 && v.texts.length <= 3, `got ${v.texts.length} lines`);
  for (const t of v.texts) assert.ok(t.length <= 180, t);
  assert.ok(/[.?!]$/.test(v.texts[0]), `first line should end at a sentence: ${v.texts[0]}`);
  assert.equal(v.texts.join(" ").startsWith("alright so bob is quiet"), true);
});

test("say splits on | or newline into staggered lines, capped at maxLines", () => {
  const v = validateDecision(
    { action: "say", text: "hc blue | u fos me i fos u\n**bob** is blatant | extra | more" },
    fixture(),
    { maxLines: 3 }
  );
  assert.equal(v.ok, true);
  assert.deepEqual(v.texts, ["hc blue", "u fos me i fos u", "bob is blatant"]);
  assert.equal(v.text, "hc blue");
});

test("say with empty text asks the model again", () => {
  const v = validateDecision({ action: "say", text: "   " }, fixture());
  assert.equal(v.ok, false);
  assert.equal(v.retry, true);
});

test("say that quotes a system message verbatim is rejected with a retry", () => {
  const v = validateDecision(
    { action: "say", text: "guys: alice was attacked by the Mafia and has died. alice was a Cop." },
    fixture()
  );
  assert.equal(v.ok, false);
  assert.equal(v.retry, true);
  assert.match(v.error, /paraphrase/);
});

test("a paraphrase of a system message is fine", () => {
  assert.equal(
    quotesSystemMessage("so alice flipped cop, mafia killed her overnight", fixture().messages),
    false
  );
});

test("say inside the pacing gap is dropped without a retry", () => {
  const now = 100000;
  const v = validateDecision({ action: "say", text: "hi" }, fixture(), {
    lastSayAt: now - 5000, sayGap: 40000, now,
  });
  assert.equal(v.ok, false);
  assert.equal(v.retry, false);
});

test("vote passes the target through for the daemon to resolve", () => {
  const v = validateDecision({ action: "vote", target: "carol" }, fixture());
  assert.deepEqual(v, { ok: true, action: "vote", meeting: "Village", target: "carol" });
});

test("vote without a target asks the model again", () => {
  const v = validateDecision({ action: "vote", target: "" }, fixture());
  assert.equal(v.ok, false);
  assert.equal(v.retry, true);
});

test("re-voting the current target is a no-op", () => {
  const raw = fixture();
  raw.meetings.m1.votes.p2 = "p3";
  const v = validateDecision({ action: "vote", target: "Carol" }, raw);
  assert.equal(v.ok, false);
  assert.equal(v.retry, false);
  assert.match(v.error, /already voting/);
});

test("vote when no votable meeting exists is dropped quietly", () => {
  const raw = fixture();
  raw.meetings.m1.canVote = false;
  const v = validateDecision({ action: "vote", target: "carol" }, raw);
  assert.equal(v.ok, false);
  assert.equal(v.retry, false);
});

test("unvote requires an existing vote", () => {
  const none = validateDecision({ action: "unvote" }, fixture());
  assert.equal(none.ok, false);
  const raw = fixture();
  raw.meetings.m1.votes.p2 = "p1";
  const v = validateDecision({ action: "unvote" }, raw);
  assert.deepEqual(v, { ok: true, action: "unvote", meeting: "Village" });
});

test("wait is refused with a retry when the turn demands an action", () => {
  const v = validateDecision({ action: "wait" }, fixture(), { mustAct: true });
  assert.equal(v.ok, false);
  assert.equal(v.retry, true);
  assert.match(v.error, /waiting is not allowed/);
  const say = validateDecision({ action: "say", text: "not me" }, fixture(), { mustAct: true });
  assert.equal(say.ok, true);
});

test("wait and unknown actions", () => {
  assert.deepEqual(validateDecision({ action: "WAIT" }, fixture()), { ok: true, action: "wait" });
  const bad = validateDecision({ action: "shoot" }, fixture());
  assert.equal(bad.ok, false);
  assert.equal(bad.retry, true);
  assert.equal(validateDecision(null, fixture()).retry, true);
});

test("parseDecision tolerates fences and prose around the object", () => {
  assert.deepEqual(parseDecision('```json\n{"action":"wait"}\n```'), { action: "wait" });
  assert.deepEqual(parseDecision('sure: {"action":"vote","target":"bob"} ok'), { action: "vote", target: "bob" });
  assert.equal(parseDecision("no json here"), null);
});

test("sanitiseChat collapses whitespace and removes markdown characters", () => {
  assert.equal(sanitiseChat(" `a`  *b*\n#c "), "a b c");
});

test("turn prompt contains role, briefing, legal actions and recent actions in order", () => {
  const p = buildTurnPrompt({
    briefing: "Phase: Day 1",
    raw: fixture(),
    roleDesc: "Villager — Village",
    recentActions: ["10s ago: said hi"],
    note: "You are acting because: test.",
  });
  const order = ["YOUR ROLE", "BRIEFING", "LEGAL ACTIONS", "YOUR RECENT ACTIONS", "NOTE", "one JSON object only"];
  let last = -1;
  for (const label of order) {
    const idx = p.indexOf(label);
    assert.ok(idx > last, `${label} missing or out of order`);
    last = idx;
  }
});

test("timeLeft decays the daemon's timer by elapsed wall time", () => {
  const raw = { timers: { main: { delay: 60000, time: 10000, receivedAt: Date.now() - 5000 } } };
  const left = timeLeft(raw);
  assert.ok(left > 44000 && left <= 45000, `got ${left}`);
  assert.equal(timeLeft({ timers: {} }), null);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
