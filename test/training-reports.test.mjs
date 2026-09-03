import assert from "node:assert/strict";
import { inferCoreReportRecipients } from "../scripts/report-visibility.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}

const players = {
  cop: { name: "Copper" },
  det: { name: "DetectiveDan" },
  stalk: { name: "StalkerSue" },
  tracker: { name: "TrackerTom" },
  scout: { name: "ScoutSam" },
  watcher: { name: "WatcherWes" },
  lookout: { name: "LookoutLou" },
  justice: { name: "JusticeJill" },
  journo: { name: "JournalistJen" },
  informant: { name: "InformantIan" },
  gramps: { name: "Grandpa" },
  actress: { name: "ActressAmy" },
  janitor: { name: "JanitorJay" },
  caroler: { name: "CarolerCal" },
  alice: { name: "Alice" },
  bob: { name: "Bob" },
  carol: { name: "Carol" },
};

const roleByPlayer = {
  cop: "Cop",
  det: "Detective",
  stalk: "Stalker",
  tracker: "Tracker",
  scout: "Scout",
  watcher: "Watcher",
  lookout: "Lookout",
  justice: "Justice",
  journo: "Journalist",
  informant: "Informant",
  gramps: "Gramps",
  actress: "Actress",
  janitor: "Janitor",
  caroler: "Caroler",
};

function state(...meetings) {
  return { meetings: Object.fromEntries(meetings.map((m, i) => [`m${i}`, m])) };
}

function recipients(content, sourceState, roles = roleByPlayer) {
  return inferCoreReportRecipients(content, { sourceState, players, roleByPlayer: roles }).recipients;
}

test("Cop report follows the actor that investigated its named target", () => {
  const night = state({ name: "Investigate", votes: { cop: "alice" } });
  assert.deepEqual(recipients(":invest: After investigating, you learn that Alice is Guilty!", night), ["cop"]);
});

test("Detective and Stalker reports remain separate when both are present", () => {
  const night = state(
    { name: "Learn Role", votes: { det: "alice" } },
    { name: "Learn Role", votes: { stalk: "bob" } }
  );
  assert.deepEqual(recipients(":invest: You Learn that Alice's Role is Villager.", night), ["det"]);
  assert.deepEqual(recipients(":invest: You Learn that Bob's Role is Cop.", night), ["stalk"]);
});

test("Tracker and Scout reports remain separate when both are present", () => {
  const night = state({ name: "Track", votes: { tracker: "alice", scout: "bob" } });
  assert.deepEqual(recipients(":track: You learn that Alice visited Bob during the night.", night), ["tracker"]);
  assert.deepEqual(recipients(":track: You learn that Bob visited no one during the night.", night), ["scout"]);
});

test("Watcher and Lookout reports remain separate when both are present", () => {
  const night = state({ name: "Watch", votes: { watcher: "alice", lookout: "bob" } });
  assert.deepEqual(recipients(":watch: You learn that Alice was visited by Bob during the night.", night), ["watcher"]);
  assert.deepEqual(recipients(":watch: You learn that Bob was visited by no one during the night.", night), ["lookout"]);
});

test("same-target counterpart checks are withheld as ambiguous", () => {
  const night = state({ name: "Watch", votes: { watcher: "alice", lookout: "alice" } });
  assert.deepEqual(recipients(":watch: You learn that Alice was visited by Bob during the night.", night), []);
});

test("Justice report matches an unordered pair", () => {
  const night = state({ name: "Compare Alignments", votes: { justice: ["alice", "bob"] } });
  assert.deepEqual(recipients(":law: You weigh the souls of Bob and Alice... they match in alignment..", night), ["justice"]);
});

test("Journalist and Informant outer reports follow their checked targets", () => {
  const night = state({ name: "Receive Reports", votes: { journo: "alice", informant: "bob" } });
  assert.deepEqual(recipients(":journ: You learn that Alice received no reports.", night), ["journo"]);
  assert.deepEqual(
    recipients(":journ: You received all reports that Bob received: :watch: You learn that Alice was visited by no one.", night),
    ["informant"]
  );
});

test("Gramps receives its passive self-visitor report", () => {
  assert.deepEqual(recipients(":watch: You learn that You were visited by Alice a Cop during the night.", state()), ["gramps"]);
});

test("a Gramps report colliding with a self-watching Lookout is withheld", () => {
  const night = state({ name: "Watch", votes: { lookout: "lookout" } });
  assert.deepEqual(recipients(":watch: You learn that You were visited by Alice during the night.", night), []);
});

test("Actress report follows Act Role target, including legacy wording", () => {
  const night = state({ name: "Act Role", votes: { actress: "alice" } });
  assert.deepEqual(recipients(":mask: After studying Alice, you learn to act like a Villager.", night), ["actress"]);
  assert.deepEqual(recipients(":mask: You learn that Alice's role is Villager.", night), ["actress"]);
});

test("Janitor mop follows the Janitor who chose to clean", () => {
  const night = state({ name: "Clean Death", votes: { janitor: "Yes" } });
  assert.deepEqual(recipients(":mop: You discover Alice's role is Villager.", night), ["janitor"]);
});

test("Carol goes to the target rather than its singer", () => {
  const night = state({ name: "Sing Carol", votes: { caroler: "bob" } });
  assert.deepEqual(recipients(":carol: You see a merry Caroler outside your house!", night), ["bob"]);
});

test("unknown private wording is recognized but withheld", () => {
  const result = inferCoreReportRecipients(":invest: some custom private result", {
    sourceState: state(), players, roleByPlayer,
  });
  assert.equal(result.recognized, true);
  assert.deepEqual(result.recipients, []);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
