// Persistent game connection + local control server.
//
// A CLI process can't hold a WebSocket open between invocations, so `um join`
// spawns this. It owns the socket, folds events into a GameState, and exposes
// a tiny HTTP API on 127.0.0.1 that the CLI drives.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { UMRest, loadConfig } from "./rest.js";
import { Knowledge } from "./knowledge.js";
import { GameState } from "./state.js";
import { renderState } from "./render.js";
import { stringifyMessage, parseMessage } from "./wire.js";
import { buildMentionRegex, isMention } from "./mentions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = path.join(ROOT, "run");
export const RUN_FILE = path.join(RUN_DIR, "daemon.json");
const LOG_FILE = path.join(RUN_DIR, "daemon.log");

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* logging must never take the daemon down */
  }
}

// constants.maxGameMessageLength upstream. The server slices silently.
const MAX_MESSAGE_LENGTH = 240;
// Self-imposed: long messages read badly in live chat and get complained about.
const SOFT_MESSAGE_LENGTH = 180;

/** Split on word boundaries so a forced-long message stays readable. */
function chunkMessage(text, limit) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

class Daemon {
  constructor({ gameId, spectate }) {
    this.gameId = gameId;
    this.spectate = spectate;
    this.config = loadConfig();
    this.rest = new UMRest(this.config);
    this.state = new GameState(gameId);
    this.knowledge = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.shuttingDown = false;
    this.pendingAlerts = [];
    this.mentions = []; // ring buffer of recent @-mentions
    this.mentionRegex = buildMentionRegex(this.config);
  }

  async start() {
    this.knowledge = await Knowledge.load({ rest: this.rest });
    await this.startControlServer();
    await this.connect();
  }

  // --- socket -------------------------------------------------------------

  async connect() {
    if (this.shuttingDown) return;

    let info;
    try {
      // The auth token expires within seconds, so it is fetched fresh on every
      // (re)connect rather than cached.
      info = await this.rest.connectInfo(this.gameId, this.spectate);
    } catch (e) {
      logLine(`connectInfo failed: ${e.message}`);
      this.state.errors.push({ t: Date.now(), message: `connect: ${e.message}` });
      this.scheduleReconnect();
      return;
    }

    this.port = info.port;
    const url = `${this.config.socketUrl || "wss://ultimafia.com"}/${info.port}`;
    logLine(`dialing ${url} (game ${this.gameId})`);

    const ws = new WebSocket(url, {
      headers: { Origin: this.config.baseUrl || "https://ultimafia.com" },
    });
    this.ws = ws;

    ws.on("open", () => {
      logLine("socket open");
      this.reconnectAttempts = 0;
      this.send("p");
    });

    ws.on("message", (raw) => this.onMessage(raw.toString(), info));
    ws.on("error", (e) => logLine(`socket error: ${e.message}`));
    ws.on("close", (code) => {
      logLine(`socket closed (${code})`);
      this.state.connected = false;
      if (this.shuttingDown) return;

      // A server-sent "left" means we are no longer in this game: another
      // client signed into the account (typically the human operator taking
      // over on the website), or we were kicked, or the game closed. In every
      // one of those cases reconnecting is wrong — against a takeover the two
      // clients would kick each other in a loop. A drop with no preceding
      // "left" is a genuine network failure and should reconnect.
      if (this.state.leftGame && !this.deliberatelyLeft) {
        this.superseded = true;
        logLine(
          "NOT reconnecting: server said we left this game (another client took over, " +
            "we were kicked, or the game closed). Run `um join <gameId>` to resume."
        );
        return;
      }

      this.scheduleReconnect();
    });
  }

  onMessage(raw, info) {
    const [eventName, data] = parseMessage(raw);

    if (eventName === "p") {
      this.send("p"); // heartbeat; the server terminates silent clients
      return;
    }

    this.state.apply(eventName, data);
    this.notifyWaiters(eventName);
    if (eventName === "message") this.checkMention(data);

    if (eventName === "connected") {
      if (info.token) this.send("auth", info.token);
      else this.send("join", { gameId: this.gameId });
    } else if (eventName === "authSuccess") {
      this.send("join", { gameId: this.gameId });
    } else if (eventName === "readyCheck init") {
      // The game kicks anyone who hasn't readied when the countdown expires.
      // We joined in order to play, so confirm immediately rather than risk
      // being dropped while waiting to be driven.
      logLine("ready check — confirming");
      this.send("readyCheck verify");
    } else if (eventName === "error" || eventName === "banned") {
      logLine(`server error: ${JSON.stringify(data)}`);
    }
  }

  /**
   * What changed since the last time we looked.
   *
   * Acting and observing used to be separate round trips, so by the time a
   * composed message landed the game had often already moved on — e.g.
   * carefully asking the Bleeder to claim seconds after they had claimed.
   * Every action now returns this, so acting and seeing are one step.
   */
  buildDigest({ consume = true } = {}) {
    const all = [...this.state.messages.values()];
    const seen = this.lastSeenMessageCount || 0;
    const fresh = all.slice(seen);
    if (consume) this.lastSeenMessageCount = all.length;

    const lines = [];
    const timer = this.state.primaryTimer();
    lines.push(
      `--- since last check: ${this.state.phaseLabel}` +
        (timer?.left != null ? `, ${Math.round(timer.left / 1000)}s left` : "") +
        ` ---`
    );

    for (const m of fresh.slice(-25)) {
      const who = m.senderId === "server" ? "***" : this.state.playerName(m.senderId);
      lines.push(`  ${who}: ${String(m.content).slice(0, 160)}`);
    }
    if (!fresh.length) lines.push("  (no new messages)");

    // Vote position matters more than anything else in the digest.
    for (const m of Object.values(this.state.meetings)) {
      if (!m.voting || !m.amMember) continue;
      const votes = m.votes || {};
      const entries = Object.entries(votes);
      const tally = {};
      for (const [, t] of entries) {
        for (const x of Array.isArray(t) ? t : [t]) tally[x] = (tally[x] || 0) + 1;
      }
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const totalVoters = (m.members || []).filter((x) => x.canVote).length;
      const tied = sorted.length > 1 && sorted[0][1] === sorted[1][1];

      lines.push(
        `  VOTES "${m.name}": ${
          sorted.map(([t, c]) => `${this.state.targetLabel(t, m)}=${c}`).join(", ") || "(none)"
        } | cast ${entries.length}/${totalVoters}${tied ? " (tied)" : ""} | yours: ${
          votes[this.state.selfId] !== undefined
            ? this.state.targetLabel(votes[this.state.selfId], m)
            : "(not cast)"
        }`
      );
      if (totalVoters && entries.length >= totalVoters - 1 && !tied) {
        lines.push(`  !! phase can END INSTANTLY on the next vote`);
      }
      if (sorted.length && sorted[0][0] === this.state.selfId && !tied) {
        lines.push(`  !! YOU are the plurality leader — consider "um unvote"`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Someone talking to us is the one event we can't afford to miss, since
   * otherwise it's only noticed on the next poll. Raises a synthetic
   * "mention" event that `um wait` can block on.
   */
  checkMention(data) {
    if (!isMention(data, { regex: this.mentionRegex, selfId: this.state.selfId })) {
      return;
    }

    const mention = {
      time: data.time || Date.now(),
      from: this.state.playerName(data.senderId),
      meeting: this.state.meetings[data.meetingId]?.name || null,
      content: data.content,
    };
    this.mentions.push(mention);
    if (this.mentions.length > 50) this.mentions.shift();

    logLine(`mention from ${mention.from}: ${mention.content}`);
    this.notifyWaiters("mention");
  }

  /**
   * Long-poll support. Playing means reacting to phase changes on a 2-minute
   * night timer, so callers block here instead of busy-polling `state`.
   */
  notifyWaiters(eventName) {
    if (!this.waiters?.length) return;
    const remaining = [];
    for (const w of this.waiters) {
      if (w.events.includes(eventName)) w.resolve(eventName);
      else remaining.push(w);
    }
    this.waiters = remaining;
  }

  waitForEvent(events, timeoutMs) {
    this.waiters = this.waiters || [];
    return new Promise((resolve) => {
      const waiter = { events, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  scheduleReconnect() {
    // Only a deliberate `um leave` should stop us reconnecting. This used to
    // check state.leftGame, which is set by a server-sent "left" event — the
    // server emits that when it replaces an old socket, so a routine drop
    // permanently wedged the daemon offline mid-game.
    if (this.shuttingDown) return;
    if (this.deliberatelyLeft) {
      logLine("not reconnecting: we left the game deliberately");
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
    logLine(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  send(eventName, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(stringifyMessage(eventName, data));
      return true;
    }
    return false;
  }

  // --- actions ------------------------------------------------------------

  doVote({ meeting: meetingHint, target }) {
    const { meeting, error } = this.state.resolveMeeting(
      meetingHint,
      this.state.votableMeetings()
    );
    if (error) return { ok: false, error };

    const resolved = this.state.resolveTarget(meeting, target);
    if (resolved.error) return { ok: false, error: resolved.error };

    const sent = this.send("vote", {
      meetingId: meeting.id,
      selection: resolved.target,
    });
    if (!sent) return { ok: false, error: "Socket not connected." };

    return {
      ok: true,
      message: `Voted ${this.state.targetLabel(resolved.target, meeting)} in "${meeting.name}".${
        meeting.instant ? " (instant meeting — resolves immediately)" : ""
      }`,
    };
  }

  doUnvote({ meeting: meetingHint, target }) {
    const { meeting, error } = this.state.resolveMeeting(
      meetingHint,
      this.state.votableMeetings()
    );
    if (error) return { ok: false, error };

    const current = meeting.votes?.[this.state.selfId];
    const selection = target || (Array.isArray(current) ? current[0] : current) || "*";

    const sent = this.send("unvote", { meetingId: meeting.id, selection });
    if (!sent) return { ok: false, error: "Socket not connected." };
    return { ok: true, message: `Unvoted in "${meeting.name}".` };
  }

  doSay({ meeting: meetingHint, text, split }) {
    const { meeting, error } = this.state.resolveMeeting(
      meetingHint,
      this.state.speakableMeetings()
    );
    if (error) return { ok: false, error };
    if (!text || !String(text).trim()) return { ok: false, error: "Empty message." };

    const content = String(text);

    // The server hard-truncates at maxGameMessageLength (240) with no warning,
    // so a long message loses its tail — which is usually the actual point.
    // Refuse rather than let that happen silently.
    if (content.length > MAX_MESSAGE_LENGTH && !split) {
      return {
        ok: false,
        error:
          `Message is ${content.length} chars; the server truncates at ${MAX_MESSAGE_LENGTH}. ` +
          `It would have been cut at: "...${content.slice(MAX_MESSAGE_LENGTH - 40, MAX_MESSAGE_LENGTH)}" ` +
          `and everything after that lost. Shorten it (preferred — long messages read badly in live chat), ` +
          `or pass split:true to send it as multiple messages.`,
      };
    }

    const parts = split ? chunkMessage(content, MAX_MESSAGE_LENGTH) : [content];
    for (const part of parts) {
      // Outbound chat is "speak"; "message" is the server->client direction.
      const sent = this.send("speak", { meetingId: meeting.id, content: part });
      if (!sent) return { ok: false, error: "Socket not connected." };
    }

    const warn =
      parts.length === 1 && content.length > SOFT_MESSAGE_LENGTH
        ? ` (note: ${content.length} chars — long for live chat, aim under ${SOFT_MESSAGE_LENGTH})`
        : "";
    return {
      ok: true,
      message: `Sent to "${meeting.name}"${parts.length > 1 ? ` in ${parts.length} parts` : ""}: ${text}${warn}`,
    };
  }

  doWill({ text }) {
    const sent = this.send("lastWill", String(text ?? ""));
    if (!sent) return { ok: false, error: "Socket not connected." };
    return { ok: true, message: "Last will set." };
  }

  async doLeave() {
    try {
      this.deliberatelyLeft = true;
      this.send("leave");
      await this.rest.leaveGame();
      this.state.leftGame = true;
      return { ok: true, message: "Left the game." };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- control server -----------------------------------------------------

  startControlServer() {
    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const reply = (code, body) => {
          const isText = typeof body === "string";
          res.writeHead(code, {
            "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json",
          });
          res.end(isText ? body : JSON.stringify(body));
        };

        let payload = {};
        if (req.method === "POST") {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks).toString();
          if (body) {
            try {
              payload = JSON.parse(body);
            } catch {
              return reply(400, { ok: false, error: "bad JSON" });
            }
          }
        }

        try {
          switch (`${req.method} ${url.pathname}`) {
            case "GET /health":
              return reply(200, {
                ok: true,
                gameId: this.gameId,
                connected: this.ws?.readyState === WebSocket.OPEN,
                superseded: Boolean(this.superseded),
                note: this.superseded
                  ? "No longer in this game (takeover, kick, or game closed). Run `um join <gameId>` to resume."
                  : undefined,
                loaded: this.state.loaded,
                started: this.state.started,
                finished: this.state.finished,
                phase: this.state.phaseLabel,
                selfId: this.state.selfId,
                isSpectator: this.state.isSpectator,
                errors: this.state.errors.slice(-5),
              });

            case "GET /state": {
              // A stale briefing that looks fine is worse than no briefing —
              // this is what let a dead socket go unnoticed mid-game.
              let banner = "";
              if (this.superseded) {
                banner =
                  "!! DISCONNECTED — no longer in this game (another client took over,\n" +
                  "!! you were kicked, or the game closed). State below is STALE.\n" +
                  "!! Run `um join <gameId>` to resume.\n\n";
              } else if (this.ws?.readyState !== WebSocket.OPEN) {
                banner =
                  "!! SOCKET NOT CONNECTED — reconnecting. State below may be stale.\n\n";
              }
              this.buildDigest();
              return reply(
                200,
                banner +
                  renderState(this.state, this.knowledge, {
                    chatLimit: Number(url.searchParams.get("chat")) || 40,
                  })
              );
            }

            case "GET /raw":
              return reply(200, {
                isSpectator: this.state.isSpectator,
                selfId: this.state.selfId,
                isSpectator: this.state.isSpectator,
                phase: this.state.phaseLabel,
                stateInfo: this.state.stateInfo,
                players: this.state.players,
                setup: this.state.setup,
                options: this.state.options,
                meetings: this.state.meetings,
                knownRoles: this.state.knownRoles(),
                dead: this.state.deadMap(),
                messages: this.state.allMessages(),
                timers: this.state.timers,
                stateEvents: this.state.stateEvents,
                finished: this.state.finished,
                winners: this.state.winners,
                errors: this.state.errors,
              });

            case "GET /wait": {
              const events = (url.searchParams.get("events") || "state,meeting,message,finished")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const timeoutMs = Math.min(
                Number(url.searchParams.get("timeout")) || 120000,
                600000
              );
              // CRITICAL: check for mentions that arrived while nothing was
              // armed BEFORE blocking. The alarm exits on each wake, so there
              // is always a window (re-arming takes seconds) where mentions are
              // detected but cannot wake anyone. Without this catch-up check a
              // question asked in that window is never answered, because we go
              // straight back to blocking for the NEXT event that may never come.
              const seenMentions = this.lastSeenMentionCount || 0;
              if (events.includes("mention") && this.mentions.length > seenMentions) {
                const missed = this.mentions.slice(seenMentions);
                this.lastSeenMentionCount = this.mentions.length;
                return reply(200, {
                  ok: true,
                  firedOn: "mention",
                  timedOut: false,
                  caughtUp: true,
                  phase: this.state.phaseLabel,
                  newMentions: missed,
                  digest: this.buildDigest(),
                });
              }

              const before = this.mentions.length;
              const fired = await this.waitForEvent(events, timeoutMs);
              this.lastSeenMentionCount = this.mentions.length;
              return reply(200, {
                ok: true,
                firedOn: fired,
                timedOut: fired === null,
                phase: this.state.phaseLabel,
                newMentions: this.mentions.slice(before),
                digest: this.buildDigest(),
              });
            }

            case "GET /mentions":
              return reply(200, { mentions: this.mentions });

            case "GET /log": {
              const since = Number(url.searchParams.get("since")) || 0;
              return reply(200, {
                total: this.state.log.length,
                events: this.state.log.slice(since),
              });
            }

            // Actions return what changed, so acting and observing are one
            // round trip instead of two.
            case "POST /vote": {
              const r = this.doVote(payload);
              return reply(200, { ...r, digest: this.buildDigest() });
            }
            case "POST /unvote": {
              const r = this.doUnvote(payload);
              return reply(200, { ...r, digest: this.buildDigest() });
            }
            case "POST /say": {
              const r = this.doSay(payload);
              return reply(200, { ...r, digest: this.buildDigest() });
            }
            case "POST /will":
              return reply(200, this.doWill(payload));
            case "POST /raw-send":
              // Escape hatch for anything the CLI doesn't wrap yet.
              return reply(200, {
                ok: this.send(payload.event, payload.data),
              });

            case "POST /leave": {
              const result = await this.doLeave();
              return reply(200, result);
            }

            case "POST /stop":
              reply(200, { ok: true, message: "Stopping." });
              this.shutdown();
              return;

            default:
              return reply(404, { ok: false, error: "unknown endpoint" });
          }
        } catch (e) {
          logLine(`control error: ${e.stack}`);
          return reply(500, { ok: false, error: e.message });
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        fs.mkdirSync(RUN_DIR, { recursive: true });
        fs.writeFileSync(
          RUN_FILE,
          JSON.stringify(
            { pid: process.pid, port, gameId: this.gameId, startedAt: Date.now() },
            null,
            2
          )
        );
        logLine(`control server on 127.0.0.1:${port} for game ${this.gameId}`);
        resolve();
      });

      this.server = server;
    });
  }

  shutdown() {
    this.shuttingDown = true;
    try {
      this.ws?.close();
    } catch { /* already gone */ }
    try {
      this.server?.close();
    } catch { /* already gone */ }
    try {
      fs.unlinkSync(RUN_FILE);
    } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 250);
  }
}

// --- entrypoint -----------------------------------------------------------

const gameId = process.argv[2];
const spectate = process.argv.includes("--spectate");

if (!gameId) {
  console.error("usage: node src/daemon.js <gameId> [--spectate]");
  process.exit(1);
}

const daemon = new Daemon({ gameId, spectate });
process.on("SIGINT", () => daemon.shutdown());
process.on("SIGTERM", () => daemon.shutdown());
process.on("uncaughtException", (e) => logLine(`uncaught: ${e.stack}`));
process.on("unhandledRejection", (e) => logLine(`unhandled: ${e}`));

daemon.start().catch((e) => {
  logLine(`fatal: ${e.stack}`);
  console.error(e);
  process.exit(1);
});
