// Infer recipients for the common private Mafia reports stored in mafia.db.
//
// The archive pools server alerts and strips their recipient ids.  For the
// standard information roles we can recover the recipient by matching the
// subject named in the report to the final action cast in the preceding
// Night.  If two actors made the same indistinguishable check, we deliberately
// return no recipients rather than leak the report to both seats.

const CORE_PREFIX = /^:(invest|track|watch|journ|law|mask|mop|carol):/i;

const ROLE_GROUPS = {
  cop: new Set(["Cop"]),
  detective: new Set(["Detective", "Stalker"]),
  tracker: new Set(["Tracker", "Scout"]),
  watcher: new Set(["Watcher", "Lookout"]),
  justice: new Set(["Justice"]),
  journalist: new Set(["Journalist", "Informant"]),
  gramps: new Set(["Gramps"]),
  actress: new Set(["Actress"]),
  janitor: new Set(["Janitor"]),
  caroler: new Set(["Caroler"]),
};

function baseRole(role) {
  return String(role || "").split(":")[0].split(" (")[0].trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exact(regexSource, content) {
  return new RegExp(regexSource, "i").test(String(content || ""));
}

function playerName(players, id) {
  return players?.[id]?.name || id;
}

function roleAllowed(roleByPlayer, actor, allowed) {
  return allowed.has(baseRole(roleByPlayer?.[actor]));
}

/** Final selections from matching meetings in an archived state. */
function finalActions(state, meetingNames, roleByPlayer, allowedRoles) {
  const wanted = new Set(meetingNames.map((name) => name.toLowerCase()));
  const actions = [];
  for (const meeting of Object.values(state?.meetings || {})) {
    if (!wanted.has(String(meeting.name || "").toLowerCase())) continue;
    for (const [actor, target] of Object.entries(meeting.votes || {})) {
      if (!roleAllowed(roleByPlayer, actor, allowedRoles)) continue;
      actions.push({ actor, target, meeting: meeting.name });
    }
  }
  return actions;
}

function uniqueRecipients(candidates, reason) {
  const recipients = [...new Set(candidates.filter(Boolean))];
  return {
    recognized: true,
    recipients: recipients.length === 1 ? recipients : [],
    reason: recipients.length === 1 ? reason : `${reason}: ${recipients.length ? "ambiguous" : "unresolved"}`,
  };
}

function singleTargetMatches(content, actions, players, patterns) {
  const matches = [];
  for (const action of actions) {
    if (Array.isArray(action.target) || action.target == null) continue;
    const name = escapeRegex(playerName(players, action.target));
    if (patterns.some((pattern) => exact(pattern(name, action), content))) matches.push(action.actor);
  }
  return matches;
}

function selfWatchMatches(content, sourceState, players, roleByPlayer) {
  const matches = [];
  const selfPattern = /^:watch:\s*You learn that You were visited by /i;
  if (!selfPattern.test(content)) return matches;

  // Watcher/Lookout can watch themselves, producing the same wording as the
  // passive Gramps report.
  for (const action of finalActions(sourceState, ["Watch"], roleByPlayer, ROLE_GROUPS.watcher)) {
    if (action.target === action.actor) matches.push(action.actor);
  }

  // Gramps has no voting meeting: its LearnVisitors card passively watches
  // itself. Multiple living Gramps are irreducibly ambiguous in this archive.
  for (const [id, role] of Object.entries(roleByPlayer || {})) {
    if (ROLE_GROUPS.gramps.has(baseRole(role))) matches.push(id);
  }
  return matches;
}

/**
 * Return the inferred recipients of a core report.
 *
 * `sourceState` should be the latest preceding Night state. An empty recipient
 * list means the alert is recognized as private but could not be assigned
 * uniquely and must be omitted from every seat's prompt.
 */
export function inferCoreReportRecipients(content, { sourceState, players, roleByPlayer } = {}) {
  const text = String(content || "");
  if (!CORE_PREFIX.test(text)) return { recognized: false, recipients: [], reason: "not a core report" };

  if (/^:invest:\s*After investigating, you learn that /i.test(text)) {
    const actions = finalActions(sourceState, ["Investigate"], roleByPlayer, ROLE_GROUPS.cop);
    return uniqueRecipients(
      singleTargetMatches(text, actions, players, [
        (name) => `^:invest:\\s*After investigating, you learn that ${name} is (?:Guilty|Innocent)!`,
      ]),
      "Cop Investigate target"
    );
  }

  if (/^:invest:\s*You Learn that /i.test(text)) {
    const actions = finalActions(sourceState, ["Learn Role"], roleByPlayer, ROLE_GROUPS.detective);
    return uniqueRecipients(
      singleTargetMatches(text, actions, players, [
        (name) => `^:invest:\\s*You Learn that ${name}'s Role is `,
      ]),
      "Detective/Stalker Learn Role target"
    );
  }

  if (/^:track:/i.test(text)) {
    const actions = finalActions(sourceState, ["Track", "Track (Boolean)"], roleByPlayer, ROLE_GROUPS.tracker);
    return uniqueRecipients(
      singleTargetMatches(text, actions, players, [
        (name) => `^:track:\\s*You learn that ${name} visited `,
        (name) => `^:track:\\s*You followed ${name}'s tracks`,
      ]),
      "Tracker/Scout Track target"
    );
  }

  if (/^:watch:/i.test(text)) {
    const candidates = selfWatchMatches(text, sourceState, players, roleByPlayer);
    if (!candidates.length) {
      const actions = finalActions(sourceState, ["Watch"], roleByPlayer, ROLE_GROUPS.watcher);
      candidates.push(
        ...singleTargetMatches(text, actions, players, [
          (name) => `^:watch:\\s*You learn that ${name} was visited by `,
        ])
      );
    }
    return uniqueRecipients(candidates, "Watcher/Lookout/Gramps watch target");
  }

  if (/^:law:/i.test(text)) {
    const matches = [];
    for (const action of finalActions(sourceState, ["Compare Alignments"], roleByPlayer, ROLE_GROUPS.justice)) {
      const targets = Array.isArray(action.target) ? action.target : [action.target];
      if (targets.length !== 2) continue;
      const a = escapeRegex(playerName(players, targets[0]));
      const b = escapeRegex(playerName(players, targets[1]));
      if (
        exact(`^:law:\\s*You weigh the souls of (?:${a} and ${b}|${b} and ${a})\\.\\.\\.`, text)
      ) {
        matches.push(action.actor);
      }
    }
    return uniqueRecipients(matches, "Justice Compare Alignments targets");
  }

  if (/^:journ:/i.test(text)) {
    const actions = finalActions(sourceState, ["Receive Reports"], roleByPlayer, ROLE_GROUPS.journalist);
    return uniqueRecipients(
      singleTargetMatches(text, actions, players, [
        (name) => `^:journ:\\s*You learn that ${name} received no reports\\.`,
        (name) => `^:journ:\\s*You received all reports that ${name} received:`,
      ]),
      "Journalist/Informant Receive Reports target"
    );
  }

  if (/^:mask:/i.test(text)) {
    const actions = finalActions(sourceState, ["Act Role"], roleByPlayer, ROLE_GROUPS.actress);
    return uniqueRecipients(
      singleTargetMatches(text, actions, players, [
        (name) => `^:mask:\\s*After studying ${name},`,
        (name) => `^:mask:\\s*You learn that ${name}'s role is `,
      ]),
      "Actress Act Role target"
    );
  }

  if (/^:mop:/i.test(text)) {
    const matches = [];
    for (const action of finalActions(sourceState, ["Clean Death", "Clean Condemnation"], roleByPlayer, ROLE_GROUPS.janitor)) {
      if (String(action.target).toLowerCase() === "yes") matches.push(action.actor);
    }
    return uniqueRecipients(matches, "Janitor clean action");
  }

  if (/^:carol:/i.test(text)) {
    const matches = [];
    for (const action of finalActions(sourceState, ["Sing Carol"], roleByPlayer, ROLE_GROUPS.caroler)) {
      const targets = Array.isArray(action.target) ? action.target : [action.target];
      matches.push(...targets);
    }
    return uniqueRecipients(matches, "Caroler target");
  }

  // A familiar private prefix with unfamiliar wording is still private.
  return { recognized: true, recipients: [], reason: "unrecognized core-report wording" };
}

