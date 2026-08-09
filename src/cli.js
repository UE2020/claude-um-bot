#!/usr/bin/env node
// Command line front end. Read-only commands hit the REST API directly;
// anything that touches a live game is proxied to the daemon.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { UMRest } from "./rest.js";
import { Knowledge } from "./knowledge.js";
import { renderSetup, renderLobby } from "./render.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_FILE = path.join(ROOT, "run", "daemon.json");
const DAEMON = path.join(ROOT, "src", "daemon.js");

// --- arg parsing ----------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

// --- daemon plumbing ------------------------------------------------------

function readRunFile() {
  if (!fs.existsSync(RUN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function daemonFetch(pathname, { method = "GET", body } = {}) {
  const run = readRunFile();
  if (!run) throw new Error("No daemon running. Use: um join <gameId>");

  const res = await fetch(`http://127.0.0.1:${run.port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function daemonAlive() {
  const run = readRunFile();
  if (!run) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${run.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startDaemon(gameId, spectate) {
  if (await daemonAlive()) {
    const run = readRunFile();
    if (run.gameId === gameId) return { reused: true, run };
    throw new Error(
      `A daemon is already connected to game ${run.gameId}. Run "um leave" or "um stop" first.`
    );
  }
  try {
    fs.unlinkSync(RUN_FILE);
  } catch { /* nothing to clean up */ }

  const args = [DAEMON, gameId];
  if (spectate) args.push("--spectate");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: ROOT,
  });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await daemonAlive()) return { reused: false, run: readRunFile() };
  }
  throw new Error("Daemon failed to come up — check run/daemon.log");
}

/** Wait until the daemon reports the initial game payload has arrived. */
async function waitLoaded(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await daemonFetch("/health");
    if (health.loaded) return health;
    if (health.errors?.length) return health;
    await sleep(300);
  }
  return daemonFetch("/health");
}

// --- helpers --------------------------------------------------------------

/** Accept either a setup id or a game id wherever a setup is expected. */
async function resolveSetup(rest, id) {
  try {
    const setup = await rest.setup(id);
    if (setup && setup.id) return setup;
  } catch { /* not a setup id — try it as a game id */ }

  const games = await rest.listGames({ list: "all", lobby: "All" });
  const game = games.find((g) => g.id === id);
  if (game?.setup?.id) return rest.setup(game.setup.id);

  throw new Error(`Could not resolve "${id}" to a setup (tried setup id and game id).`);
}

function printResult(result) {
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  if (result.ok === false) {
    console.error(`ERROR: ${result.error}`);
    // Even a rejected action should report what changed — the reason the
    // action was wrong is often visible in what just happened.
    if (result.digest) console.log(result.digest);
    process.exitCode = 1;
    return;
  }
  if (result.message) console.log(result.message);
  else console.log(JSON.stringify(result, null, 2));
  if (result.digest) console.log(result.digest);
}

const USAGE = `
um — UltiMafia client

Reference / lobby (no connection needed):
  um whoami                       Show the logged-in account
  um lobby [--list all|open|"in progress"] [--lobby Main|Sandbox|All]
  um setup <setupId|gameId>       Every role in the setup, with descriptions
  um guides <setupId|gameId>      Player-written strategy guides for that setup
  um role <RoleName>              Description of a single role
  um rules                        Primer on how UltiMafia games work
  um find <name>                  Search setups by name
  um host <setupId> [--ranked] [--name "..."] [--lobby Main] [--day 10] [--night 2]
                                  Create a game. Ready check is ON by default
                                  (--no-ready-check to disable). Ranked games
                                  may not be private/competitive/guests.

Playing (daemon-backed):
  um fill [--lobby L] [--ranked]  Join whichever open game needs fewest players
                                  (leaves your current game first; reports if
                                  you lost the race and landed as a spectator)
  um join <gameId>                Join as a PLAYER and hold the connection open
  um spectate <gameId>            Connect to a full/in-progress game as a spectator
  um state [--chat N]             The full briefing — read this before acting
  um wait [--timeout ms]          Block until the phase changes OR someone mentions you
  um alarm [--timeout ms]         Like wait, but for run_in_background: exits on phase
                                  change so you get a completion notification.
                                  ALWAYS have one of these armed during a game.
  um mentions                     Recent messages that mentioned you
  um raw                          Same data as JSON
  um watch [--since N]            Raw event log from index N
  um say "<text>" [--meeting M]
  um vote <target> [--meeting M]  Target = player name, "no one", "Yes"/"No", role name
  um unvote [--meeting M]
  um will "<text>"                Set your last will
  um send <event> <json>          Escape hatch: raw socket event
  um status                       Daemon health
  um leave                        Leave the game (also releases your slot)
  um stop                         Kill the daemon without leaving

Notes:
  * Joining an OPEN game always seats you as a player — there is no spectate
    flag on join. Spectating only happens when the game is full or started.
  * Meeting names are matched case-insensitively by substring.
`.trimStart();

// --- commands -------------------------------------------------------------

async function main() {
  const [, , command, ...rest_] = process.argv;
  const { positional, flags } = parseArgs(rest_);
  const rest = new UMRest();

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;

    case "whoami": {
      const me = await rest.whoami();
      console.log(`${me.name}  (id ${me.id})  games played: ${me.gamesPlayed}, red hearts: ${me.redHearts}`);
      return;
    }

    case "lobby": {
      const games = await rest.listGames({
        list: flags.list || "all",
        lobby: flags.lobby || "All",
        page: Number(flags.page) || 1,
      });
      console.log(renderLobby(games));
      return;
    }

    case "setup": {
      const knowledge = await Knowledge.load({ rest, refresh: !!flags.refresh });
      const setup = await resolveSetup(rest, positional[0]);
      console.log(renderSetup(setup, knowledge, null));
      return;
    }

    case "guides": {
      const knowledge = await Knowledge.load({ rest });
      const setup = await resolveSetup(rest, positional[0]);
      const strategies = await rest.strategies(setup.id);
      console.log(renderSetup(setup, knowledge, strategies || []));
      return;
    }

    case "role": {
      const knowledge = await Knowledge.load({ rest, refresh: !!flags.refresh });
      const name = positional.join(" ");
      console.log(knowledge.describe(name));
      return;
    }

    case "rules": {
      console.log(fs.readFileSync(path.join(ROOT, "docs", "UM_RULES.md"), "utf8"));
      return;
    }

    case "find": {
      const results = await rest.searchSetups(positional.join(" "), flags.gameType || "Mafia");
      const setups = results.setups || results;
      if (!setups.length) return console.log("(no setups matched)");
      for (const s of setups) {
        console.log(
          `  ${String(s.id).padEnd(11)} ${String(s.name).padEnd(28)} ${String(
            s.total
          ).padStart(2)}p  ranked=${!!s.ranked} competitive=${!!s.competitive} closed=${!!s.closed}`
        );
      }
      return;
    }

    case "host": {
      const setupId = positional[0];
      if (!setupId) throw new Error('usage: um host <setupId> [--ranked] [--name "..."]');

      const setup = await rest.setup(setupId);
      const ranked = Boolean(flags.ranked);

      // Fail early with a useful message rather than eating a bare 403/forbidden.
      if (ranked && !setup.ranked) {
        throw new Error(`"${setup.name}" is not approved for ranked play.`);
      }
      if (ranked && (flags.private || flags.guests || flags.competitive)) {
        throw new Error("Ranked games cannot be private, competitive, or allow guests.");
      }

      const readyCheck = flags["no-ready-check"] ? false : true;
      const gameId = await rest.hostGame({
        setup: setupId,
        lobby: flags.lobby || "Main",
        lobbyName: flags.name,
        ranked,
        competitive: Boolean(flags.competitive),
        isPrivate: Boolean(flags.private),
        guests: Boolean(flags.guests),
        spectating: !flags["no-spectating"],
        readyCheck,
        stateLengths: {
          Day: Number(flags.day) || 10,
          Night: Number(flags.night) || 2,
        },
      });

      console.log(
        `Hosted ${setup.name} (${setup.total}p) — game ${gameId}` +
          `  [${ranked ? "ranked" : "unranked"}, readyCheck=${readyCheck}]`
      );
      console.log(`https://ultimafia.com/game/${gameId}`);
      console.log(`Next: um join ${gameId}`);
      return;
    }

    case "fill": {
      // Find the open game closest to filling and join it. Lobby counts go
      // stale in seconds on a quiet night, so this re-reads immediately before
      // joining and reports honestly if we lost the race and landed as a
      // spectator instead of a player.
      const games = (await rest.listGames({ list: "open", lobby: flags.lobby || "All" }))
        .filter((g) => g.setup?.total && g.players != null)
        .filter((g) => !flags.ranked || g.ranked)
        .map((g) => ({ ...g, needs: g.setup.total - g.players }))
        .filter((g) => g.needs > 0)
        .sort((a, b) => a.needs - b.needs);

      if (!games.length) return console.log("(no open games needing players)");

      console.log("Open games by how many they still need:");
      for (const g of games) {
        console.log(`  ${String(g.id).padEnd(11)} needs ${g.needs}  ${g.setup.name} (${g.players}/${g.setup.total})${g.ranked ? " ranked" : ""}`);
      }

      const target = games[0];
      const run = readRunFile();
      if (run && (await daemonAlive()) && run.gameId === target.id) {
        return console.log(`Already connected to ${target.id}.`);
      }
      if (run && (await daemonAlive())) {
        console.log(`Leaving ${run.gameId}…`);
        await daemonFetch("/leave", { method: "POST" }).catch(() => {});
        await daemonFetch("/stop", { method: "POST" }).catch(() => {});
        await sleep(1200);
      }

      console.log(`Joining ${target.id} (${target.setup.name}, needs ${target.needs})…`);
      await startDaemon(target.id, false);
      const health = await waitLoaded();
      const raw = await daemonFetch("/raw").catch(() => ({}));
      if (raw.isSpectator) {
        console.log(`!! LOST THE RACE — ${target.id} filled before you connected; you are a SPECTATOR.`);
      } else {
        console.log(`Seated as a player in ${target.id} (phase ${health.phase}).`);
      }
      return;
    }

    case "join":
    case "spectate": {
      const gameId = positional[0];
      if (!gameId) throw new Error(`usage: um ${command} <gameId>`);

      // Spectating is for games that are already full or in progress. On a game
      // that still has room the server will seat you as a PLAYER anyway, via a
      // code path that does not apply the same server-side eligibility checks
      // as a normal join. Always use `join` for open games so those checks run.
      if (command === "spectate" && !flags.force) {
        const games = await rest.listGames({ list: "open", lobby: "All" }).catch(() => []);
        const open = games.find((g) => g.id === gameId);
        if (open && open.setup?.total && open.players < open.setup.total) {
          throw new Error(
            `${gameId} is open with room (${open.players}/${open.setup.total}). ` +
              `Spectate-connecting to an open game seats you as a PLAYER without the ` +
              `normal eligibility checks. Use "um join ${gameId}" instead.`
          );
        }
      }

      const { reused } = await startDaemon(gameId, command === "spectate");
      const health = await waitLoaded();

      if (health.errors?.length) {
        console.error(`Server reported: ${health.errors.map((e) => e.message).join("; ")}`);
      }
      console.log(
        `${reused ? "Already connected to" : "Connected to"} game ${gameId} — ` +
          `phase ${health.phase}, loaded=${health.loaded}, you are ${health.selfId || "(not seated)"}`
      );
      console.log(`Run "um state" for the full briefing.`);
      return;
    }

    case "state":
      printResult(await daemonFetch(`/state?chat=${Number(flags.chat) || 40}`));
      return;

    case "raw":
      console.log(JSON.stringify(await daemonFetch("/raw"), null, 2));
      return;

    case "watch": {
      const since = Number(flags.since) || 0;
      const data = await daemonFetch(`/log?since=${since}`);
      console.log(`total events: ${data.total}`);
      for (const e of data.events) {
        console.log(`${e.event}: ${JSON.stringify(e.data)?.slice(0, 400) ?? ""}`);
      }
      return;
    }

    case "wait": {
      // Blocks until the game does something, then prints the fresh briefing.
      // "mention" is in the default set so being spoken to always wakes us.
      const events = flags.events || "state,meeting,finished,mention";
      const timeout = Number(flags.timeout) || 120000;
      const result = await daemonFetch(
        `/wait?events=${encodeURIComponent(events)}&timeout=${timeout}`
      );
      console.log(
        result.timedOut
          ? `(timed out after ${timeout}ms — phase ${result.phase})`
          : `--- woke on "${result.firedOn}" — phase ${result.phase} ---`
      );
      for (const m of result.newMentions || []) {
        console.log(
          `>>> MENTION from ${m.from}${m.meeting ? ` in {${m.meeting}}` : ""}: ${m.content}`
        );
      }
      if (result.digest) console.log(result.digest);
      if (!flags.quiet) {
        printResult(await daemonFetch(`/state?chat=${Number(flags.chat) || 40}`));
      }
      return;
    }

    case "alarm": {
      // Run this with run_in_background: it blocks until the phase actually
      // changes (or someone speaks to you), then EXITS so the harness raises a
      // completion notification. That notification is what makes the operator
      // notice a new phase without being told. Survives daemon restarts, which
      // a plain `wait` does not.
      const events = flags.events || "state,finished,mention";
      const deadline = Date.now() + (Number(flags.timeout) || 1800000);
      const startPhase = (await daemonFetch("/health").catch(() => ({}))).phase;

      while (Date.now() < deadline) {
        try {
          // Clamp each blocking poll to the time actually left, or the inner
          // wait overshoots our own deadline.
          const chunk = Math.max(1000, Math.min(60000, deadline - Date.now()));
          const result = await daemonFetch(
            `/wait?events=${encodeURIComponent(events)}&timeout=${chunk}`
          );
          for (const m of result.newMentions || []) {
            console.log(`>>> MENTION from ${m.from}: ${m.content}`);
          }
          if (!result.timedOut) {
            console.log(
              `*** WAKE: "${result.firedOn}"${result.caughtUp ? " (MISSED while unarmed — catching up)" : ""} — phase is now ${result.phase} ***`
            );
            if (result.firedOn === "state" || result.firedOn === "finished") return;
            if (result.newMentions?.length) return;
          }
          if (result.phase && result.phase !== startPhase) {
            console.log(`*** PHASE CHANGED: ${startPhase} -> ${result.phase} ***`);
            return;
          }
        } catch {
          // Daemon restarting or briefly unreachable — keep watching.
          await sleep(2000);
        }
      }
      console.log(`(alarm expired — phase still ${startPhase})`);
      return;
    }

    case "mentions": {
      const data = await daemonFetch("/mentions");
      if (!data.mentions?.length) console.log("(no mentions yet)");
      for (const m of data.mentions) {
        console.log(
          `[${new Date(m.time).toLocaleTimeString()}] ${m.from}${
            m.meeting ? ` in {${m.meeting}}` : ""
          }: ${m.content}`
        );
      }
      return;
    }

    case "status": {
      const health = await daemonFetch("/health");
      console.log(JSON.stringify(health, null, 2));
      return;
    }

    case "say":
      printResult(
        await daemonFetch("/say", {
          method: "POST",
          body: {
            meeting: flags.meeting,
            text: positional.join(" "),
            split: Boolean(flags.split),
          },
        })
      );
      return;

    case "vote":
      printResult(
        await daemonFetch("/vote", {
          method: "POST",
          body: { meeting: flags.meeting, target: positional.join(" ") },
        })
      );
      return;

    case "unvote":
      printResult(
        await daemonFetch("/unvote", {
          method: "POST",
          body: { meeting: flags.meeting, target: positional.join(" ") || undefined },
        })
      );
      return;

    case "will":
      printResult(
        await daemonFetch("/will", {
          method: "POST",
          body: { text: positional.join(" ") },
        })
      );
      return;

    case "send": {
      const event = positional[0];
      let data;
      if (positional[1]) {
        try {
          data = JSON.parse(positional.slice(1).join(" "));
        } catch {
          data = positional.slice(1).join(" ");
        }
      }
      printResult(await daemonFetch("/raw-send", { method: "POST", body: { event, data } }));
      return;
    }

    case "leave": {
      printResult(await daemonFetch("/leave", { method: "POST" }));
      await daemonFetch("/stop", { method: "POST" }).catch(() => {});
      return;
    }

    case "stop":
      printResult(await daemonFetch("/stop", { method: "POST" }));
      return;

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
});
