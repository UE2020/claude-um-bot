// Renders GameState into a text briefing dense enough to play from.

import { Knowledge } from "./knowledge.js";
import { visibleSenderId } from "./messages.js";

function hr(title) {
  return `\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`;
}

function fmtDuration(ms) {
  if (ms == null) return "?";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function fmtClock(t) {
  if (!t) return "--:--";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function messageSpeaker(state, message, { system = "***" } = {}) {
  const senderId = visibleSenderId(message);
  return senderId === "server" ? system : state.playerName(senderId);
}

function hasCryAbility(meeting) {
  return (meeting.speechAbilities || []).some(
    (ability) => String(ability?.name || "").toLowerCase() === "cry"
  );
}

export function renderState(state, knowledge, opts = {}) {
  const chatLimit = opts.chatLimit ?? 40;
  const out = [];
  const known = state.knownRoles();
  const dead = state.deadMap();

  // --- header -------------------------------------------------------------
  const setupName = state.setup?.name || "?";
  const total = state.setup?.total ?? "?";
  const startState = knowledge.startState(state.setup);
  const timer = state.primaryTimer();

  out.push(`════ UltiMafia · game ${state.gameId} ════`);
  if (state.selfId && state.deadMap()[state.selfId]) {
    out.push(
      `!! YOU ARE DEAD. Living players CANNOT see what you type — dead chat is
` +
        `!! graveyard-only. Anything you "tell town" from here goes nowhere.`
    );
  }
  if (state.isSpectator) {
    out.push(
      `!! YOU ARE A SPECTATOR — you are NOT in this game and cannot act.
` +
        `!! (the game filled or started before you connected)`
    );
  }
  out.push(
    `Setup: ${setupName} (${total}p, ${startState}-start)   Phase: ${state.phaseLabel}` +
      (timer ? `   Time left: ${fmtDuration(timer.left)} (${timer.name})` : "")
  );

  const flags = [];
  if (state.setup?.closed) flags.push("CLOSED setup (roles hidden)");
  if (state.setup?.noReveal) flags.push("no role reveal on death");
  if (state.setup?.mustCondemn) flags.push("must condemn");
  if (state.setup?.mustAct) flags.push("must act");
  if (state.setup?.dawn) flags.push("dawn phase");
  if (state.setup?.lastWill) flags.push("last wills on");
  if (state.setup?.whispers) flags.push("whispers on");
  if (state.options?.anonymousGame) flags.push("ANONYMOUS game");
  if (state.options?.ranked) flags.push("ranked");
  if (state.options?.competitive) flags.push("competitive");
  if (flags.length) out.push(`Flags: ${flags.join(" · ")}`);

  if (!state.started) out.push(`Status: PREGAME — waiting for players to fill.`);
  if (state.finished) out.push(`Status: GAME OVER`);
  if (state.winners) {
    const w = state.winners;
    const groups = w.groups || w;
    out.push(`Winners: ${JSON.stringify(groups)}`);
  }

  // --- me -----------------------------------------------------------------
  out.push(hr("ME"));
  const me = state.self;
  const myAppearance = state.selfId ? known[state.selfId] : null;
  out.push(`${me?.name || "(unknown)"}   id=${state.selfId || "?"}`);
  if (myAppearance) {
    out.push(knowledge.describe(myAppearance));
  } else if (state.started) {
    out.push("  (role not yet assigned / not revealed to you)");
  }
  if (state.lastWill) out.push(`  Last will: ${state.lastWill}`);

  // Items are only included on your own player payload. They matter a lot —
  // guns, armor and bombs are what many setups actually turn on.
  const inventory = me?.inventory || [];
  if (inventory.length) {
    out.push(
      `  Inventory: ${inventory
        .map((i) => `${i.name}${i.hasAction ? " (has action)" : ""}`)
        .join(", ")}`
    );
  }

  if (state.stateEvents?.length) {
    out.push(`  Active state events: ${state.stateEvents.join(", ")}`);
  }

  // --- players ------------------------------------------------------------
  const players = Object.values(state.players).sort(
    (a, b) => Number(a.playerListPosition ?? 0) - Number(b.playerListPosition ?? 0)
  );
  // Players who leave stay in the payload flagged `left`, so they must not be
  // counted as live seats.
  const seated = players.filter((p) => !p.left);
  const aliveCount = seated.filter((p) => !dead[p.id]).length;

  out.push(hr(`PLAYERS (${aliveCount} alive / ${seated.length} seated)`));
  for (const p of players) {
    const isMe = p.id === state.selfId;
    const status = p.left
      ? "LEFT "
      : state.exorcised[p.id]
        ? "EXORC"
        : dead[p.id]
          ? "DEAD "
          : "alive";
    const roleStr = known[p.id] ? `  ${known[p.id]}` : "";
    const marker = isMe ? " <- YOU" : "";
    out.push(
      `  ${String(p.playerListPosition ?? "?").padStart(2)}. ${(p.name || "?").padEnd(20)} ${status}${roleStr}${marker}`
    );
  }

  // --- what I know --------------------------------------------------------
  const teammates = Object.entries(known).filter(
    ([pid]) => pid !== state.selfId && state.players[pid]
  );
  if (teammates.length) {
    out.push(hr("ROLES KNOWN TO YOU"));
    out.push(
      "  (own role + faction partners revealed at assignment + investigation results + flips)"
    );
    for (const [pid, appearance] of teammates) {
      out.push(`  ${state.playerName(pid).padEnd(20)} ${appearance}`);
      const { role } = Knowledge.splitAppearance(appearance);
      const info = knowledge.role(role);
      if (info) out.push(`      ${info.alignment} / ${info.category} — ${info.description}`);
    }
  }

  // --- deaths -------------------------------------------------------------
  const obits = [...state.obituaries.values()].sort((a, b) => (a.time || 0) - (b.time || 0));
  if (obits.length) {
    out.push(hr("OBITUARIES"));
    for (const ob of obits) {
      const entries = ob.obituaries || [];
      if (!entries.length) {
        out.push(`  ${ob.source}: nobody died.`);
        continue;
      }
      for (const entry of entries) {
        const who = entry.playerInfo?.name || state.playerName(entry.id);
        out.push(`  ${ob.source}: ${who}`);
        for (const text of Object.values(entry.snippets || {})) {
          out.push(`      ${text}`);
        }
      }
    }
  }

  // --- system messages ----------------------------------------------------
  const sys = state.systemMessages();
  if (sys.length) {
    out.push(hr(`SYSTEM / REPORTS (${sys.length})`));
    // The wire format strips recipient info (see Message.parseMessageInfoObj
    // upstream), so a faction-only alert is indistinguishable from public lore.
    // Restating one can hand the enemy something only your side was told.
    out.push("  !! THESE MAY BE PRIVATE TO YOU — the wire carries no recipient info,");
    out.push("  !! so a Village-only alert looks identical to public lore here.");
    out.push("  !! NEVER restate one as public knowledge.");
    for (const m of sys.slice(-60)) {
      out.push(`  [${fmtClock(m.time)}] ${m.content}`);
    }
  }

  // --- meetings -----------------------------------------------------------
  const meetings = Object.values(state.meetings);
  out.push(hr(`MEETINGS (${meetings.length})`));
  if (!meetings.length) out.push("  (none active)");

  for (const m of meetings) {
    const caps = [];
    if (m.voting) caps.push("voting");
    if (m.speech) caps.push("chat");
    if (m.instant) caps.push("INSTANT (resolves immediately)");
    if (m.multi) caps.push(`multi-select (${m.multiMin ?? "?"}-${m.multiMax ?? "?"})`);
    if (m.anonymous) caps.push("anonymous");
    if (m.noUnvote) caps.push("no unvote");
    if (!m.amMember) caps.push("observer only");

    out.push(
      `\n  * "${m.name}"${m.actionName && m.actionName !== m.name ? ` — action: ${m.actionName}` : ""}`
    );
    out.push(`      id=${m.id}  [${caps.join(", ") || "no capabilities"}]`);
    out.push(
      `      you: ${m.amMember ? "member" : "not a member"}` +
        `, canVote=${!!m.canVote}, canTalk=${!!m.canTalk}, inputType=${m.inputType || "-"}`
    );

    if (m.voting) {
      out.push(`      legal targets: ${state.describeTargets(m)}`);

      const votes = m.votes || {};
      const entries = Object.entries(votes);
      if (entries.length) {
        const lines = entries.map(
          ([voter, target]) =>
            `${state.playerName(voter)}→${
              Array.isArray(target)
                ? target.map((t) => state.targetLabel(t, m)).join("+")
                : state.targetLabel(target, m)
            }`
        );
        out.push(`      votes: ${lines.join(", ")}`);

        // Tally. UM condemns the plurality leader — no majority needed.
        const tally = {};
        for (const [, target] of entries) {
          for (const t of Array.isArray(target) ? target : [target]) {
            tally[t] = (tally[t] || 0) + 1;
          }
        }
        const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        out.push(
          `      tally: ${sorted
            .map(([t, c]) => `${state.targetLabel(t, m)}=${c}`)
            .join(", ")}`
        );

        // A meeting resolves the instant every voter has voted AND there is a
        // single plurality leader — the phase ends with no further discussion.
        // Unvoting keeps votesCast < totalVoters, which blocks that entirely.
        const totalVoters = (m.members || []).filter((x) => x.canVote).length;
        const votesCast = entries.length;
        const tied = sorted.length > 1 && sorted[0][1] === sorted[1][1];
        out.push(`      votes cast: ${votesCast}/${totalVoters}${tied ? " (tied — no plurality)" : ""}`);

        if (totalVoters && votesCast >= totalVoters - 1 && !tied) {
          out.push(
            `      !! ${votesCast === totalVoters ? "ALL" : "ALL BUT ONE"} VOTED — this phase can END INSTANTLY on the next vote`
          );
        }
        if (sorted.length && sorted[0][0] === state.selfId && !tied) {
          out.push(
            `      !! YOU ARE THE PLURALITY LEADER — you are what gets condemned if this resolves now`
          );
          if (votes[state.selfId] !== undefined) {
            out.push(
              `      !! consider "um unvote" — removing your vote blocks the instant resolution and buys talking time`
            );
          }
        }
        if (m.amMember && votes[state.selfId] !== undefined) {
          out.push(
            `      YOUR VOTE: ${state.targetLabel(votes[state.selfId], m)}`
          );
        } else if (m.amMember && m.canVote) {
          out.push(`      YOUR VOTE: (not cast)`);
        }
      } else {
        out.push(`      votes: (none yet)`);
      }
    }

    const msgs = (m.messages || []).slice(-6);
    if (msgs.length) {
      out.push(`      recent in-meeting:`);
      for (const msg of msgs) {
        out.push(`        ${messageSpeaker(state, msg, { system: "SYSTEM" })}: ${msg.content}`);
      }
    }
  }

  // --- chat ---------------------------------------------------------------
  const chat = state.allMessages().slice(-chatLimit);
  out.push(hr(`CHAT (last ${chat.length})`));
  for (const m of chat) {
    const meetingName = state.meetings[m.meetingId]?.name;
    const where = meetingName ? `{${meetingName}} ` : "";
    const who = messageSpeaker(state, m);
    const prefixStr = m.prefix ? ` (${m.prefix})` : "";
    out.push(`  [${fmtClock(m.time)}] ${where}${who}${prefixStr}: ${m.content}`);
  }

  // --- what you can do ----------------------------------------------------
  out.push(hr("AVAILABLE ACTIONS"));
  const votable = state.votableMeetings();
  const speakable = state.speakableMeetings();

  if (!votable.length && !speakable.length) {
    out.push("  (nothing to do right now)");
  }
  for (const m of votable) {
    out.push(`  um vote <target> --meeting "${m.name}"     # ${m.actionName || m.name}`);
  }
  for (const m of speakable) {
    out.push(`  um say "<text>" --meeting "${m.name}"`);
    if (hasCryAbility(m)) {
      out.push(`  um cry "<text>"                            # Broadcast anonymous message`);
    }
  }

  if (state.errors.length) {
    out.push(hr("ERRORS"));
    for (const e of state.errors.slice(-10)) out.push(`  ${e.message}`);
  }

  if (state.unknownEvents.size) {
    out.push(`\n(unhandled socket events seen: ${[...state.unknownEvents].join(", ")})`);
  }

  return out.join("\n");
}

export function calculateParity(state, knowledge) {
  if (!state || !state.players) return null;
  const dead = state.deadMap ? state.deadMap() : {};
  const seated = Object.values(state.players).filter((p) => !p.left);
  const alive = seated.filter((p) => !dead[p.id]);
  const aliveCount = alive.length;
  if (aliveCount === 0) return null;

  const counts = knowledge?.alignmentCounts && state.setup ? knowledge.alignmentCounts(state.setup) : {};
  const totalMafia = (counts["Mafia"] || 0) + (counts["Cult"] || 0) + (counts["Werewolf"] || 0);

  const known = state.knownRoles ? state.knownRoles() : {};
  let deadMafia = 0;
  for (const p of seated) {
    if (dead[p.id] && known[p.id]) {
      const { role } = Knowledge.splitAppearance(known[p.id]);
      const info = knowledge?.role ? knowledge.role(role) : null;
      if (info && (info.alignment === "Mafia" || info.alignment === "Cult" || info.alignment === "Werewolf")) {
        deadMafia++;
      }
    }
  }

  const estimatedAliveMafia = Math.max(1, totalMafia - deadMafia);
  const miscondemns = Math.max(0, Math.floor((aliveCount - 2 * estimatedAliveMafia) / 2));

  let status = null;
  let warning = null;
  if (miscondemns === 0 && aliveCount > 2) {
    status = "LYLO (Lynch or Lose)";
    warning = "!! LYLO: Miscondemn loses the game. Plurality vote on Town = defeat. DO NOT NO-CONDEMN.";
  } else if (miscondemns === 1 && aliveCount % 2 === 0) {
    status = "MYLO (Mislynch and Lose)";
    warning = "!! MYLO: Miscondemn loses tomorrow. A no-condemn keeps parity.";
  } else {
    status = `${miscondemns} miscondemn${miscondemns === 1 ? "" : "s"} budget`;
  }

  return {
    aliveCount,
    totalSeated: seated.length,
    estimatedAliveMafia,
    miscondemns,
    status,
    warning,
  };
}

export function renderCompactState(state, knowledge, opts = {}) {
  const chatLimit = opts.chatLimit ?? 10;
  const out = [];
  const known = state.knownRoles();
  const dead = state.deadMap();
  const timer = state.primaryTimer();
  const parity = calculateParity(state, knowledge);

  // --- Header ---
  const timerStr = timer?.left != null ? ` (${fmtDuration(timer.left)} left)` : "";
  const parityStr = parity?.status ? ` | Parity: ${parity.status}` : "";
  const seated = Object.values(state.players).filter((p) => !p.left);
  const aliveCount = seated.filter((p) => !dead[p.id]).length;

  out.push(`════ UltiMafia · Game ${state.gameId} [COMPACT] ════`);
  out.push(`Phase: ${state.phaseLabel}${timerStr} | Alive: ${aliveCount}/${seated.length}${parityStr}`);

  if (state.selfId && dead[state.selfId]) {
    out.push(`!! YOU ARE DEAD (graveyard chat only — living cannot hear you).`);
  }
  if (state.isSpectator) {
    out.push(`!! YOU ARE A SPECTATOR (observer only).`);
  }
  if (parity?.warning) {
    out.push(parity.warning);
  }
  if (!state.started) out.push(`Status: PREGAME — waiting to fill.`);
  if (state.finished) out.push(`Status: GAME OVER${state.winners ? ` — Winners: ${JSON.stringify(state.winners)}` : ""}`);

  // --- Me ---
  const me = state.self;
  const myAppearance = state.selfId ? known[state.selfId] : null;
  const inv = me?.inventory?.length
    ? ` | Items: ${me.inventory.map((i) => `${i.name}${i.hasAction ? "(action)" : ""}`).join(", ")}`
    : "";
  const will = state.lastWill ? ` | Will: "${state.lastWill}"` : "";
  out.push(`YOU: ${me?.name || "(unknown)"} (id=${state.selfId || "?"}) | Role: ${myAppearance || (state.started ? "(unrevealed)" : "Pregame")}${inv}${will}`);

  // Teammates / known roles (compact 1-liner if any)
  const teammates = Object.entries(known).filter(([pid]) => pid !== state.selfId && state.players[pid]);
  if (teammates.length) {
    out.push(`Known roles: ${teammates.map(([pid, app]) => `${state.playerName(pid)}=${app}`).join(", ")}`);
  }

  // --- Players (compact inline) ---
  const alivePlayers = seated.filter((p) => !dead[p.id]);
  const deadPlayers = seated.filter((p) => dead[p.id]);

  const aliveStrs = alivePlayers.map((p) => {
    const role = known[p.id] ? ` (${known[p.id]})` : "";
    const meMarker = p.id === state.selfId ? " [YOU]" : "";
    return `${p.name}${role}${meMarker}`;
  });
  out.push(`Alive (${alivePlayers.length}): ${aliveStrs.join(", ") || "(none)"}`);

  if (deadPlayers.length) {
    const deadStrs = deadPlayers.map((p) => {
      const role = known[p.id] ? ` (${known[p.id]})` : "";
      return `${p.name}${role}`;
    });
    out.push(`Dead (${deadPlayers.length}): ${deadStrs.join(", ")}`);
  }

  // --- Votes & Meetings ---
  const votable = state.votableMeetings();
  if (votable.length) {
    out.push(`\n── VOTES ──────────────────────────────────────────`);
    for (const m of votable) {
      const votes = m.votes || {};
      const entries = Object.entries(votes);
      const totalVoters = (m.members || []).filter((x) => x.canVote).length;
      const tally = {};
      for (const [, target] of entries) {
        for (const t of Array.isArray(target) ? target : [target]) {
          tally[t] = (tally[t] || 0) + 1;
        }
      }
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const tallyStr = sorted.map(([t, c]) => `${state.targetLabel(t, m)}=${c}`).join(", ") || "(none)";
      const myVote = votes[state.selfId] !== undefined ? state.targetLabel(votes[state.selfId], m) : "(not cast)";
      const tied = sorted.length > 1 && sorted[0][1] === sorted[1][1];

      out.push(`* "${m.name}": ${tallyStr} | cast ${entries.length}/${totalVoters}${tied ? " (tied)" : ""} | yours: ${myVote}`);

      if (totalVoters && entries.length >= totalVoters - 1 && !tied) {
        out.push(`  !! Phase can END INSTANTLY on next vote`);
      }
      if (sorted.length && sorted[0][0] === state.selfId && !tied) {
        out.push(`  !! YOU ARE PLURALITY LEADER — consider "um unvote"`);
      }
    }
  }

  // --- System messages / Reports (current phase or last 6) ---
  const sys = state.systemMessages();
  const currentPhaseReports = sys.filter((m) => m.stateId === state.currentStateId);
  const reportsToShow = currentPhaseReports.length > 0 ? currentPhaseReports : sys.slice(-6);
  if (reportsToShow.length) {
    out.push(`\n── REPORTS (${reportsToShow.length} in ${state.phaseLabel}) ────────────`);
    for (const m of reportsToShow) {
      out.push(`  [${fmtClock(m.time)}] ${m.content}`);
    }
  }

  // --- Chat (Delta by default, or explicit slice) ---
  const all = state.allMessages();
  let chat;
  let chatLabel;

  if (opts.messages) {
    chat = opts.messages;
    chatLabel = opts.chatLabel || `${chat.length} messages`;
  } else if (opts.sinceIndex != null) {
    chat = all.slice(opts.sinceIndex);
    chatLabel = opts.sinceIndex === 0
      ? `first look — recent ${chat.length}`
      : `${chat.length} new since last look`;
  } else if (opts.chatLimit != null) {
    chat = all.slice(-opts.chatLimit);
    chatLabel = `last ${chat.length}`;
  } else {
    chat = all.slice(-20);
    chatLabel = `last ${chat.length}`;
  }

  out.push(`\n── CHAT (${chatLabel}) ──────────────────────────`);
  if (!chat.length) {
    out.push("  (no new messages)");
  }
  for (const m of chat) {
    const meetingName = state.meetings[m.meetingId]?.name;
    const where = meetingName ? `{${meetingName}} ` : "";
    const who = messageSpeaker(state, m);
    const prefixStr = m.prefix ? ` (${m.prefix})` : "";
    out.push(`  [${fmtClock(m.time)}] ${where}${who}${prefixStr}: ${m.content}`);
  }

  // --- Quick Actions Hint ---
  out.push(`\n── ACTIONS ────────────────────────────────────────`);
  const speakable = state.speakableMeetings();
  const acts = [];
  for (const m of votable) acts.push(`um vote <target> --meeting "${m.name}"`);
  for (const m of speakable) {
    acts.push(`um say "<text>" --meeting "${m.name}"`);
    if (hasCryAbility(m)) acts.push(`um cry "<text>" --meeting "${m.name}"`);
  }
  acts.push(`um alarm (wait) | um state --full (detailed rules)`);
  out.push(`  ${acts.join(" | ")}`);

  return out.join("\n");
}

export function renderSetup(setup, knowledge, strategies) {
  const out = [];
  out.push(`Setup: ${setup.name}  (id ${setup.id})`);
  out.push(
    `Players: ${setup.total}   Start: ${knowledge.startState(setup)}-start   Closed: ${!!setup.closed}   Game: ${setup.gameType}`
  );
  if (setup.description) out.push(`Description: ${setup.description}`);

  const flags = [];
  for (const key of [
    "dawn",
    "noReveal",
    "mustAct",
    "mustCondemn",
    "lastWill",
    "whispers",
    "votesInvisible",
    "unique",
  ]) {
    if (setup[key]) flags.push(key);
  }
  if (flags.length) out.push(`Flags: ${flags.join(", ")}`);

  const roster = knowledge.expandSetup(setup);
  const counts = knowledge.alignmentCounts(setup);
  out.push(
    `\nAlignments: ${Object.entries(counts)
      .map(([a, c]) => `${a} ${c}`)
      .join("  ·  ")}`
  );

  out.push(hr("ROLES IN PLAY"));
  for (const r of roster) {
    const label = r.modifiers.length ? `${r.role} [${r.modifiers.join(", ")}]` : r.role;
    const cat = r.category && r.category !== "?" ? ` / ${r.category}` : "";
    out.push(`\n  ${r.count}x ${label}   (${r.alignment}${cat})`);
    if (r.description) out.push(`      ${r.description}`);
    if (r.nightOrder.length) out.push(`      Night order: ${r.nightOrder.join(", ")}`);
    for (const mod of r.modifiers) {
      const m = knowledge.modifier(mod);
      out.push(`      * ${mod}: ${m ? m.description : "(no data)"}`);
    }
    out.push(...knowledge.noteLines(r.role, "      "));
  }

  if (strategies && strategies.length) {
    out.push(hr(`STRATEGY GUIDES (${strategies.length})`));
    for (const s of strategies) {
      out.push(`\n  ### ${s.title || "(untitled)"}  — by ${s.author?.name || "?"} (score ${s.voteCount ?? 0})`);
      const content = String(s.content || "").trim();
      out.push(
        content
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    }
  } else if (strategies) {
    out.push(hr("STRATEGY GUIDES"));
    out.push("  (none posted for this setup)");
  }

  return out.join("\n");
}

export function renderLobby(games) {
  const out = [`${games.length} games`];
  for (const g of games) {
    const setup = g.setup || {};
    out.push(
      `  ${String(g.id).padEnd(11)} ${String(g.status).padEnd(9)} ${String(
        setup.name || "?"
      ).padEnd(24)} ${String(g.players ?? "-").padStart(2)}/${String(
        setup.total ?? "?"
      ).padEnd(3)} ${String(g.lobby || "").padEnd(8)} ${g.ranked ? "ranked " : ""}${
        g.competitive ? "comp " : ""
      }${g.anonymousGame ? "anon " : ""}${g.private ? "private " : ""}setup=${setup.id || "?"}`
    );
  }
  return out.join("\n");
}
