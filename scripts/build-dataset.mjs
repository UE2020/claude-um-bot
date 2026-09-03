#!/usr/bin/env node
// Turn the mafia.db game archive into supervised examples for fine-tuning.
//
// Every game is replayed from each chosen seat's point of view through the
// client's own GameState and renderer, so the prompt a training example
// carries is byte-for-byte what src/agent.js would have sent at that moment.
// The target is what the human in that seat did next: a chat line (or a few
// in quick succession), a vote, or an unvote.
//
//   node scripts/build-dataset.mjs --out data/train.jsonl [--limit-games N]
//        [--all-seats] [--min-players 5] [--min-chat 100] [--chat 30]
//
// Output: JSON lines of {"messages": [system, user, assistant], "meta": {...}}
// which is the chat format Unsloth / TRL SFTTrainer accept directly.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GameState } from "../src/state.js";
import { renderCompactState } from "../src/render.js";
import { Knowledge } from "../src/knowledge.js";
import { buildTurnPrompt, splitChat, parseArgs, DEFAULTS } from "../src/agent.js";
import { buildMentionRegex, isHostile, classifySystemMessage } from "../src/mentions.js";
import { inferCoreReportRecipients } from "./report-visibility.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- what each seat is allowed to see ------------------------------------

const FACTIONS = new Set(["Mafia", "Cult", "Werewolf", "Coven", "Vampire"]);

// Alerts nobody needs in a briefing: lobby noise, protips, cosmetics.
const NOISE = [
  /^Protip/i, /fortune!$/, /^:star:/, / is ready\.$/, / has joined\.$/, / has left\.$/,
  /^Game filled/, /^Kicking/, /Graveyard participation/, /You will be kicked/,
  /speaking too quickly/, /voting too quickly/, /received kudos/, / is now hosting/,
  /^You have received a gun/, /^:gun\d*: You/, /Daily Challenge/, /^Please enter a dictionary/,
];

/**
 * Decide whether seat P sees an alert. Core private reports are assigned by
 * matching their named target to the final action in the preceding Night.
 * Ambiguous and unresolved core reports are withheld from every seat.
 */
function alertVisible(content, { sourceState, seat, players, roleByPlayer, faction, partnerNames }) {
  if (NOISE.some((re) => re.test(content))) return false;
  const report = inferCoreReportRecipients(content, { sourceState, players, roleByPlayer });
  if (report.recognized) return report.recipients.includes(seat);
  if (/^:system: .+'s role is /.test(content)) {
    // Partner reveal at role assignment: only the faction sees it.
    if (!FACTIONS.has(faction)) return false;
    return partnerNames.some((n) => content.includes(`${n}'s role is`));
  }
  if (/^:system: Your role is/.test(content)) return false; // renderer already shows the role
  // Unknown second-person alerts are safer to omit than to teach every seat
  // private information. Public deaths, flips and gunshots do not use this
  // form and continue through below.
  if (/^:[^:]+:\s*(?:You|Your)\b/i.test(content)) return false;
  if (/^(?:You|Your)\b/i.test(content)) return false;
  return true;
}

// --- helpers ---------------------------------------------------------------

function ago(ms) {
  return `${Math.round(ms / 1000)}s ago`;
}

function baseStateName(name) {
  return String(name || "").replace(/\s*\d+\s*$/, "");
}

function dayCount(name) {
  const m = String(name || "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

function targetLabel(state, meeting, target) {
  if (target === "*") return meeting?.noOneDisplayName || "No One";
  return state.playerName(target);
}

/** Async stream of parsed game records from the SQLite archive. */
async function* streamGames(dbPath, limit, offset) {
  const py = spawn("python", [path.join(ROOT, "scripts", "dump-games.py"), dbPath, String(limit), String(offset)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const rl = readline.createInterface({ input: py.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      yield { id: row.id, game: JSON.parse(row.content) };
    } catch {
      /* skip unparseable rows */
    }
  }
}

// --- replay ----------------------------------------------------------------

function gameUsable(g, opts) {
  if (g.type !== "Mafia") return "not mafia";
  if (!Array.isArray(g.players) || g.players.length < opts.minPlayers) return "too small";
  if (!g.winners?.length) return "no winners";
  if (!g.history) return "no history";
  return null;
}

function chatCount(h) {
  let n = 0;
  for (const st of Object.values(h)) {
    for (const m of Object.values(st.meetings || {})) {
      if (m.name === "Village") n += (m.messages || []).length;
    }
  }
  return n;
}

/**
 * Replay one game from one seat. Calls emit(sample) for every action the
 * seat took during a live phase.
 */
function replaySeat(g, h, seat, ctx, opts, emit) {
  const { players, roleByPlayer, alignByPlayer, knowledge, systemPrompt } = ctx;
  const P = seat;
  const myRole = roleByPlayer[P];
  const myFaction = alignByPlayer[P];
  const partners = FACTIONS.has(myFaction)
    ? Object.keys(players).filter((id) => id !== P && alignByPlayer[id] === myFaction)
    : [];
  const partnerNames = partners.map((id) => players[id].name);
  const mentionRegex = buildMentionRegex({}, players[P].name);

  const st = new GameState(g.id);
  st.selfId = P;
  st.players = players;
  st.setup = g.setup;
  st.options = { ranked: Boolean(g.ranked) };
  st.started = true;
  st.loaded = true;

  const visibleRoles = { [P]: myRole };
  for (const id of partners) visibleRoles[id] = roleByPlayer[id];

  const roleDesc = knowledge.describe(myRole);
  const stateIds = Object.keys(h).map(Number).filter((n) => n >= 0).sort((a, b) => a - b);
  const lengths = g.stateLengths || {};

  const recent = []; // {time, line}
  let lastNightState = null;
  let previousDead = {};
  let samplesFromSeat = 0;
  let lastActionAt = 0;
  let lastDay = 0;

  for (const sid of stateIds) {
    const s = h[String(sid)];
    if (!s || /^(Pregame|Postgame)$/.test(s.name)) continue;
    const day = dayCount(s.name) || lastDay;
    lastDay = day;
    st.stateInfo = { name: s.name, id: sid, dayCount: day };
    st.meetings = {};

    // An archived state's `dead` map is its final snapshot. Starting the
    // replay from it would reveal daytime gun victims before the shot. Begin
    // with the preceding state's final snapshot and fold instant obituaries
    // in at their recorded timestamps below.
    const startDead = { ...previousDead };
    const obituaryEntries = new Map();
    const instantDeaths = new Set();
    for (const obituary of Object.values(s.obituaries || {})) {
      for (const entry of obituary?.obituaries || []) {
        obituaryEntries.set(entry.id, entry);
        // Non-instant obituaries are boundary results from the preceding
        // phase, so these players are already dead when this state begins.
        if (/^instant-/i.test(String(obituary.source || ""))) instantDeaths.add(entry.id);
        else startDead[entry.id] = true;
      }
    }
    for (const [id, dead] of Object.entries(startDead)) {
      if (!dead || !roleByPlayer[id]) continue;
      const entry = obituaryEntries.get(id);
      if (entry?.snippets?.revealMessage || (!entry && !g.setup?.noReveal)) {
        visibleRoles[id] = roleByPlayer[id];
      }
    }
    st.history[sid] = {
      name: s.name,
      meetings: {},
      alerts: [],
      roles: { ...visibleRoles },
      dead: startDead,
      stateEvents: [],
    };

    for (const obituary of Object.values(s.obituaries || {})) {
      if (!obituary?.id) continue;
      if (/^instant-/i.test(String(obituary.source || "")) && obituary.time != null) continue;
      st.obituaries.set(obituary.id, obituary);
    }

    const myMeetings = [];
    for (const m of Object.values(s.meetings || {})) {
      let member = (m.members || []).find((x) => x.id === P);
      // Meeting snapshots are final too. A player killed by an instant action
      // has already been removed from Village in the archive, even though they
      // could talk and vote earlier in the same state.
      if (!member && m.name === "Village" && instantDeaths.has(P) && !startDead[P]) {
        member = { id: P, canVote: true };
      }
      if (!member) continue;
      myMeetings.push(m);
      let members = m.members || [];
      let targets = m.targets;
      if (m.name === "Village" && instantDeaths.size) {
        members = members.slice();
        targets = Array.isArray(targets) ? targets.slice() : targets;
        for (const id of instantDeaths) {
          if (startDead[id]) continue;
          if (!members.some((x) => x.id === id)) members.push({ id, canVote: true });
          if (Array.isArray(targets) && !targets.includes(id)) {
            const abstain = targets.indexOf("*");
            if (abstain >= 0) targets.splice(abstain, 0, id);
            else targets.push(id);
          }
        }
      }
      st.meetings[m.id] = {
        ...m,
        members,
        targets,
        messages: undefined,
        voteRecord: undefined,
        votes: {},
        amMember: true,
        canVote: member.canVote !== false,
        canTalk: m.speech !== false,
      };
    }

    // Everything that happened this state, in time order.
    const events = [];
    for (const m of myMeetings) {
      for (const msg of m.messages || []) {
        if (msg.time == null) continue;
        events.push({ t: msg.time, kind: "msg", meetingId: m.id, msg });
      }
      for (const rec of m.voteRecord || []) {
        if (rec.time == null) continue;
        events.push({ t: rec.time, kind: "vote", meetingId: m.id, rec });
      }
    }
    for (const obituary of Object.values(s.obituaries || {})) {
      if (!obituary?.id || obituary.time == null) continue;
      if (/^instant-/i.test(String(obituary.source || ""))) {
        events.push({ t: obituary.time, kind: "obituary", obituary });
      }
    }
    for (const a of s.alerts || []) {
      if (a.time == null || !a.content) continue;
      if (alertVisible(a.content, {
        sourceState: lastNightState,
        seat: P,
        players,
        roleByPlayer,
        faction: myFaction,
        partnerNames,
      })) {
        events.push({ t: a.time, kind: "alert", alert: a });
      }
    }
    events.sort((a, b) => a.t - b.t);
    if (!events.length) {
      if (/^Night\b/.test(s.name)) lastNightState = s;
      previousDead = { ...previousDead, ...(s.dead || {}) };
      continue;
    }

    const stateStart = events[0].t;
    const stateLen = lengths[baseStateName(s.name)] || (/^Night/.test(s.name) ? 120000 : 600000);
    let firstActionInState = true;
    const sinceLast = { mentions: [], alerts: [], voters: new Set() };

    const applyEvent = (ev) => {
      if (ev.kind === "msg") {
        st.addMessage({ ...ev.msg, meetingId: ev.meetingId });
        const c = String(ev.msg.content || "");
        if (ev.msg.senderId !== P && ev.msg.senderId !== "server" && mentionRegex.test(c)) {
          const meetingName = st.meetings[ev.meetingId]?.name || "";
          sinceLast.mentions.push({
            from: st.playerName(ev.msg.senderId),
            content: c,
            hostile: !/mafia|cult/i.test(meetingName) && isHostile(c),
            faction: /mafia|cult/i.test(meetingName),
            meeting: meetingName,
          });
        }
      } else if (ev.kind === "vote") {
        const rec = ev.rec;
        const data = { meetingId: ev.meetingId, voterId: rec.voterId, target: rec.target };
        if (rec.type === "unvote") st.applyUnvote(data);
        else st.applyVote(data);
        if (rec.voterId !== P && rec.target === P && rec.type !== "unvote") {
          sinceLast.voters.add(st.playerName(rec.voterId));
        }
      } else if (ev.kind === "alert") {
        st.addMessage({ ...ev.alert, senderId: "server", meetingId: undefined });
        const kind = classifySystemMessage(ev.alert.content);
        if (kind) sinceLast.alerts.push({ kind, content: ev.alert.content });
      } else if (ev.kind === "obituary") {
        st.obituaries.set(ev.obituary.id, ev.obituary);
        for (const entry of ev.obituary.obituaries || []) {
          st.liveDead[entry.id] = true;
          st.history[sid].dead[entry.id] = true;
          if (entry.snippets?.revealMessage && roleByPlayer[entry.id]) {
            visibleRoles[entry.id] = roleByPlayer[entry.id];
            st.history[sid].roles[entry.id] = roleByPlayer[entry.id];
          }
          for (const meeting of Object.values(st.meetings)) {
            if (Array.isArray(meeting.targets)) {
              meeting.targets = meeting.targets.filter((id) => id !== entry.id);
            }
            if (Array.isArray(meeting.members)) {
              meeting.members = meeting.members.filter((member) => member.id !== entry.id);
            }
          }
        }
      }
    };

    const buildNote = (t) => {
      if (firstActionInState) return `phase changed to ${st.phaseLabel}`;
      const lines = [];
      for (const a of sinceLast.alerts.slice(-3)) {
        lines.push(`a system message (${a.kind}): "${a.content.slice(0, 160)}"`);
      }
      for (const m of sinceLast.mentions.slice(-3)) {
        const content = m.content.slice(0, 160);
        if (m.faction) lines.push(`${m.from} in ${m.meeting}: "${content}"`);
        else if (m.hostile) lines.push(`${m.from} pushed against you: "${content}"`);
        else lines.push(`${m.from} addressed you: "${content}"`);
      }
      let note = lines.slice(-3).join("; ");
      if (sinceLast.voters.size) {
        const line = `${[...sinceLast.voters].join(", ")} just voted you`;
        note = note ? `${note}; ${line}` : line;
      }
      if (note) return note;
      return /^Night/.test(s.name) ? "you have not chosen your night action yet" : "it is your turn to contribute";
    };

    const emitSample = (t, target, summary) => {
      st.timers = { main: { delay: stateLen, time: Math.max(0, t - stateStart), receivedAt: Date.now() } };
      const briefing = renderCompactState(st, knowledge, { chatLimit: opts.chat });
      const raw = {
        selfId: P,
        players,
        meetings: st.meetings,
        messages: [...st.messages.values()],
        knownRoles: st.knownRoles(),
        dead: st.deadMap(),
      };
      const recentActions = recent.slice(-6).map((a) => `${ago(t - a.time)}: ${a.line}`);
      const note = `You are acting because: ${buildNote(t)}.`;
      const user = buildTurnPrompt({ briefing, raw, roleDesc, recentActions, note });
      emit({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: user },
          { role: "assistant", content: JSON.stringify(target) },
        ],
        meta: {
          game: g.id,
          player: players[P].name,
          role: myRole,
          faction: myFaction,
          won: ctx.winners.has(P),
          phase: st.phaseLabel,
          action: target.action,
          setup: g.setup?.name,
        },
      });
      recent.push({ time: t, line: summary });
      if (recent.length > 6) recent.shift();
      firstActionInState = false;
      sinceLast.mentions = [];
      sinceLast.alerts = [];
      sinceLast.voters = new Set();
      lastActionAt = t;
      samplesFromSeat++;
    };

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const meeting = ev.meetingId ? st.meetings[ev.meetingId] : null;

      if (ev.kind === "msg" && ev.msg.senderId === P && meeting?.canTalk) {
        // Group this and the seat's next few lines in the same meeting, the
        // way the harness sends a multi-line turn.
        const lines = [];
        let j = i;
        while (j < events.length && lines.length < DEFAULTS.maxLines) {
          const e = events[j];
          if (e.kind === "msg" && e.msg.senderId === P && e.meetingId === ev.meetingId && e.t - ev.t <= 15000) {
            lines.push(String(e.msg.content || ""));
            j++;
          } else if (e.kind === "msg" && e.msg.senderId === P) {
            break;
          } else if (e.t - ev.t <= 15000) {
            j++; // other events interleaved within the window still belong before the next line
          } else break;
        }
        const clean = splitChat(lines.filter((l) => !l.startsWith("/")).join(" | "), DEFAULTS.maxLines);
        if (clean.length) {
          emitSample(
            ev.t,
            { action: "say", meeting: meeting.name, target: "", text: clean.join(" | ") },
            `said in "${meeting.name}": ${clean.join(" | ")}`
          );
        }
        // Apply everything up to j in order (our own lines included).
        for (let k = i; k < Math.max(j, i + 1); k++) applyEvent(events[k]);
        i = Math.max(j, i + 1) - 1;
        continue;
      }

      if (ev.kind === "vote" && ev.rec.voterId === P && meeting?.canVote) {
        const rec = ev.rec;
        if (rec.type === "unvote") {
          emitSample(ev.t, { action: "unvote", meeting: meeting.name, target: "", text: "" }, `unvoted in "${meeting.name}"`);
        } else {
          const current = meeting.votes?.[P];
          if (current !== rec.target) {
            const label = targetLabel(st, meeting, rec.target);
            emitSample(ev.t, { action: "vote", meeting: meeting.name, target: label, text: "" }, `voted ${label} in "${meeting.name}"`);
          }
        }
        applyEvent(ev);
        continue;
      }

      applyEvent(ev);
    }

    // Reports generated by this Night arrive in a later state (normally Day,
    // but some setups insert Dawn or another intermediate state).
    if (/^Night\b/.test(s.name)) lastNightState = s;
    previousDead = { ...previousDead, ...(s.dead || {}) };
  }
  return samplesFromSeat;
}

function replayGame(g, ctxBase, opts, emit) {
  const h = typeof g.history === "string" ? JSON.parse(g.history) : g.history;
  const pim = JSON.parse(g.playerIdMap || "{}"); // userId -> playerId
  const roleMap = JSON.parse(g.playerRoleMap || "{}"); // userId -> role
  const alignMap = JSON.parse(g.playerAlignmentMap || "{}");
  const roleByPlayer = {};
  const alignByPlayer = {};
  for (const [uid, pid] of Object.entries(pim)) {
    if (roleMap[uid]) roleByPlayer[pid] = roleMap[uid];
    if (alignMap[uid]) alignByPlayer[pid] = alignMap[uid];
  }
  const players = {};
  (g.players || []).forEach((pid, i) => {
    players[pid] = { id: pid, name: g.names?.[i] || pid, playerListPosition: i };
  });
  const winners = new Set(g.winners || []);
  const ctx = { ...ctxBase, players, roleByPlayer, alignByPlayer, winners };

  let seats = Object.keys(players).filter((pid) => roleByPlayer[pid]);
  if (!opts.allSeats) seats = seats.filter((pid) => winners.has(pid));

  let n = 0;
  for (const seat of seats) n += replaySeat(g, h, seat, ctx, opts, emit);
  return { seats: seats.length, samples: n, chat: chatCount(h) };
}

// --- entrypoint --------------------------------------------------------------

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const opts = {
    db: flags.db || path.join(ROOT, "mafia.db"),
    out: flags.out || path.join(ROOT, "data", "train.jsonl"),
    limitGames: Number(flags["limit-games"] || -1),
    offset: Number(flags.offset || 0),
    minPlayers: Number(flags["min-players"] || 5),
    minChat: Number(flags["min-chat"] || 100),
    chat: Number(flags.chat || 30),
    allSeats: Boolean(flags["all-seats"]),
    prompt: flags.prompt ? path.resolve(flags.prompt) : DEFAULTS.prompt,
  };

  const systemPrompt = fs.readFileSync(opts.prompt, "utf8");
  const knowledge = await Knowledge.load();
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const out = fs.createWriteStream(opts.out);

  const stats = { games: 0, used: 0, skipped: {}, seats: 0, samples: 0, byAction: {}, byPhase: {} };
  const emit = (sample) => {
    out.write(JSON.stringify(sample) + "\n");
    stats.samples++;
    stats.byAction[sample.meta.action] = (stats.byAction[sample.meta.action] || 0) + 1;
    const ph = baseStateName(sample.meta.phase);
    stats.byPhase[ph] = (stats.byPhase[ph] || 0) + 1;
  };

  for await (const { game } of streamGames(opts.db, opts.limitGames, opts.offset)) {
    stats.games++;
    const why = gameUsable(game, opts);
    if (why) {
      stats.skipped[why] = (stats.skipped[why] || 0) + 1;
      continue;
    }
    let r;
    try {
      const h = JSON.parse(game.history);
      if (chatCount(h) < opts.minChat) {
        stats.skipped["too little chat"] = (stats.skipped["too little chat"] || 0) + 1;
        continue;
      }
      r = replayGame(game, { knowledge, systemPrompt }, opts, emit);
    } catch (e) {
      stats.skipped[`error: ${e.message.slice(0, 60)}`] = (stats.skipped[`error: ${e.message.slice(0, 60)}`] || 0) + 1;
      continue;
    }
    stats.used++;
    stats.seats += r.seats;
    if (stats.games % 250 === 0) console.error(`… ${stats.games} games read, ${stats.samples} samples`);
  }
  out.end();
  await new Promise((r) => out.on("finish", r));

  console.log(JSON.stringify({ ...stats, out: opts.out }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
