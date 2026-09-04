#!/usr/bin/env node
// Local-model harness. Drives the daemon's HTTP control API with a model
// served by Ollama, so a small local model can play without an LLM
// harness such as Claude Code around it.
//
// One loop: read the briefing -> ask the model for ONE JSON decision ->
// validate it against the daemon's legal targets -> dispatch -> block on
// GET /wait until something happens. Every model call is stateless: the
// system prompt is byte-identical each time (so Ollama's prefix cache
// skips it) and the user message is only the current board.
//
//   node src/agent.js [--model qwen3.5:4b] [--dry-run] [--bench]
//
// Run `um join <gameId>` first; the harness attaches to that daemon.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Knowledge } from "./knowledge.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_FILE = path.join(ROOT, "run", "daemon.json");
const LOG_FILE = path.join(ROOT, "run", "agent.log");
const DEFAULT_PROMPT = path.join(ROOT, "prompts", "local-agent.md");

const MAX_MESSAGE_LENGTH = 240;
const SOFT_MESSAGE_LENGTH = 180;

export const DEFAULTS = {
  model: "qwen3.5:4b",
  ollama: "http://127.0.0.1:11434",
  prompt: DEFAULT_PROMPT,
  chat: 12, // max chat lines shown to the model per turn
  // Max tokens in the part of the prompt that changes between turns. Hybrid
  // recurrent models (Qwen3.5) can't resume from an arbitrary cached prefix:
  // llama.cpp only keeps checkpoints ~512 tokens before the end of the last
  // prompt, so if the changing tail is longer than that, every turn
  // re-processes the whole prompt (60s+ on this CPU instead of ~20s).
  tailBudget: 480,
  cadence: 45000, // ms between proactive day turns when nothing wakes us
  sayGap: 15000, // ms minimum between our own turns that speak
  maxLines: 3, // chat messages one turn may send, staggered a few seconds apart
  linesPerMinute: 4, // hard ceiling on chat lines, whatever wakes us
  numCtx: 4096,
  numPredict: 200,
  temperature: 0.7,
  keepAlive: "30m",
};

// The model must return exactly this shape. Ollama enforces it with
// grammar-constrained decoding, which is what makes a 4B model usable
// here at all — free-form tool calling at this size is too flaky.
export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    action: { type: "string", enum: ["say", "cry", "vote", "unvote", "wait"] },
    meeting: { type: "string" },
    target: { type: "string" },
    text: { type: "string" },
  },
  required: ["action"],
};

// --- small utilities ------------------------------------------------------

export function parseArgs(argv) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stamp() {
  return new Date().toLocaleTimeString();
}

function log(line) {
  const text = `[${stamp()}] ${line}`;
  console.log(text);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, text + "\n");
  } catch {
    /* logging is best-effort */
  }
}

function ago(ms) {
  return `${Math.round(ms / 1000)}s ago`;
}

// --- daemon client --------------------------------------------------------

function readRunFile() {
  if (!fs.existsSync(RUN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function daemon(pathname, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const run = readRunFile();
  if (!run) throw new Error("No daemon running. Use: um join <gameId>");
  const res = await fetch(`http://127.0.0.1:${run.port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Milliseconds left on the phase timer, from the raw timers payload. */
export function timeLeft(raw) {
  const timers = raw?.timers || {};
  const t = timers.main || timers.secondary || Object.values(timers)[0];
  if (!t || t.delay == null || t.time == null) return null;
  return Math.max(0, t.delay - t.time - (Date.now() - (t.receivedAt || Date.now())));
}

// --- prompt construction --------------------------------------------------

function playerName(raw, id) {
  if (id === "*") return "No One";
  return raw.players?.[id]?.name || String(id);
}

function meetingsOf(raw) {
  return Object.values(raw.meetings || {});
}

export function votableMeetings(raw) {
  return meetingsOf(raw).filter((m) => m.amMember && m.voting && m.canVote);
}

export function speakableMeetings(raw) {
  return meetingsOf(raw).filter((m) => m.amMember && m.speech && m.canTalk);
}

function hasCryAbility(meeting) {
  return (meeting.speechAbilities || []).some(
    (ability) => String(ability?.name || "").toLowerCase() === "cry"
  );
}

export function cryableMeetings(raw) {
  return speakableMeetings(raw).filter(hasCryAbility);
}

function isSpeechAction(action) {
  return action === "say" || action === "cry";
}

/**
 * The machine-readable half of the briefing: exactly which meetings the
 * model may act in and what it may put in them. Built from /raw rather than
 * parsed out of the prose so the two can't drift apart.
 */
export function legalActionsBlock(raw) {
  const lines = [];
  for (const m of votableMeetings(raw)) {
    // Text-input meetings carry a filter object instead of a target list.
    const targets = (Array.isArray(m.targets) ? m.targets : []).map((t) => {
      if (t === "*") return m.noOneDisplayName || "No One";
      return playerName(raw, t);
    });
    const mine = m.votes?.[raw.selfId];
    const mineLabel =
      mine === undefined
        ? "(not cast)"
        : (Array.isArray(mine) ? mine : [mine]).map((t) => playerName(raw, t)).join(", ");
    const instant = m.instant ? " (instant — resolves immediately)" : "";
    lines.push(`VOTE "${m.name}"${instant}: targets = ${targets.join(", ") || "(none)"}; yours = ${mineLabel}`);
  }
  for (const m of speakableMeetings(raw)) {
    lines.push(`SAY "${m.name}"`);
    if (hasCryAbility(m)) lines.push(`CRY "${m.name}" (anonymous broadcast)`);
  }
  if (!lines.length) lines.push("(nothing to do right now — use wait)");
  return lines.join("\n");
}

export function buildTurnPrompt({ briefing, raw, roleDesc, recentActions, note }) {
  const parts = [];
  if (roleDesc) parts.push(`YOUR ROLE\n${roleDesc}`);
  parts.push(`BRIEFING\n${briefing.trim()}`);
  parts.push(`LEGAL ACTIONS\n${legalActionsBlock(raw)}`);
  if (recentActions?.length) {
    parts.push(`YOUR RECENT ACTIONS\n${recentActions.join("\n")}`);
  }
  if (note) parts.push(`NOTE\n${note}`);
  parts.push("Decide your next action. Reply with one JSON object only.");
  return parts.join("\n\n");
}

// --- decision validation --------------------------------------------------

function normalise(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hard rule 2 in code: refuse chat that contains a long run of any system
 * message verbatim. A 4B model will quote a cop report the moment it is
 * asked to "share what you know", and the daemon cannot tell it not to.
 */
export function quotesSystemMessage(text, messages, window = 30) {
  const hay = normalise(text);
  if (hay.length < window) return false;
  for (const m of messages || []) {
    if (m.senderId !== "server") continue;
    const src = normalise(m.content);
    if (src.length < window) continue;
    for (let i = 0; i + window <= src.length; i += 8) {
      if (hay.includes(src.slice(i, i + window))) return true;
    }
  }
  return false;
}

export function sanitiseChat(text) {
  return String(text || "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Humans in live chat send several short lines, not one paragraph. The
 * model may separate lines with "|" or a newline; each becomes its own
 * message, sent a few seconds apart.
 */
export function splitChat(text, maxLines = 3) {
  const parts = String(text || "")
    .replace(/[`*_#>]/g, "")
    .split(/\s*(?:\n|\|)\s*/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // A long paragraph becomes several lines broken at sentence ends, rather
  // than one line the server silently truncates mid-thought.
  const lines = [];
  for (const part of parts) {
    let rest = part;
    while (rest.length > SOFT_MESSAGE_LENGTH) {
      const window = rest.slice(0, SOFT_MESSAGE_LENGTH);
      let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      if (cut < 40) cut = window.lastIndexOf(", ");
      if (cut < 40) cut = window.lastIndexOf(" ");
      if (cut < 40) cut = SOFT_MESSAGE_LENGTH - 1;
      lines.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) lines.push(rest);
  }
  return lines.map(sanitiseChat).filter(Boolean).slice(0, maxLines);
}

export function speechRequestBody(action, meeting, text) {
  const body = { meeting, text };
  if (action === "cry") {
    body.ability = "Cry";
    body.abilityTarget = "out";
  }
  return body;
}

function pickMeeting(hint, pool) {
  if (!pool.length) return { error: "no meeting available for that action" };
  const lower = String(hint || "").trim().toLowerCase();
  if (lower) {
    const exact = pool.find((m) => (m.name || "").toLowerCase() === lower);
    if (exact) return { meeting: exact };
    const partial = pool.filter((m) => (m.name || "").toLowerCase().includes(lower));
    if (partial.length === 1) return { meeting: partial[0] };
  }
  // Small models leave the field blank or invent a name. The day meeting is
  // the sensible default; otherwise take the only/first option.
  const village = pool.find((m) => /^(village|day)$/i.test(m.name || ""));
  return { meeting: village || pool[0] };
}

/**
 * Turn the model's JSON into a daemon request, or explain why not.
 * `retry: true` means the error is worth showing the model for a second
 * attempt; otherwise we just do nothing this turn.
 */
export function validateDecision(
  decision,
  raw,
  { lastSayAt = 0, sayGap = 0, now = Date.now(), mustAct = false, maxLines = 3 } = {}
) {
  if (!decision || typeof decision !== "object") {
    return { ok: false, retry: true, error: "reply was not a JSON object" };
  }
  const action = String(decision.action || "").toLowerCase();

  if (action === "wait") {
    // Waiting is fine on a routine tick. It is not fine when we were woken
    // because someone addressed us, pushed on us, or a gun went off — that
    // is the lurking that gets a player vote-kicked.
    if (mustAct) {
      return {
        ok: false,
        retry: true,
        error: "something just happened that concerns you; waiting is not allowed this turn. Reply with say, cry, or vote",
      };
    }
    return { ok: true, action: "wait" };
  }

  if (isSpeechAction(action)) {
    const texts = splitChat(decision.text, maxLines);
    if (!texts.length) return { ok: false, retry: true, error: `${action} needs non-empty text` };
    const pool = action === "cry" ? cryableMeetings(raw) : speakableMeetings(raw);
    const { meeting, error } = pickMeeting(decision.meeting, pool);
    if (error) return { ok: false, retry: false, error };
    if (texts.some((t) => quotesSystemMessage(t, raw.messages))) {
      return {
        ok: false,
        retry: true,
        error: "that message quotes a system message word for word; paraphrase it in your own words",
      };
    }
    if (now - lastSayAt < sayGap) {
      return { ok: false, retry: false, error: `spoke ${ago(now - lastSayAt)}; pacing` };
    }
    return { ok: true, action, meeting: meeting.name, text: texts[0], texts };
  }

  if (action === "vote") {
    const target = String(decision.target || "").trim();
    if (!target) return { ok: false, retry: true, error: "vote needs a target" };
    const { meeting, error } = pickMeeting(decision.meeting, votableMeetings(raw));
    if (error) return { ok: false, retry: false, error };
    const mine = meeting.votes?.[raw.selfId];
    if (mine !== undefined) {
      const current = (Array.isArray(mine) ? mine : [mine]).map((t) => playerName(raw, t).toLowerCase());
      if (current.includes(target.toLowerCase())) {
        return { ok: false, retry: false, error: `already voting ${target}` };
      }
    }
    return { ok: true, action: "vote", meeting: meeting.name, target };
  }

  if (action === "unvote") {
    const { meeting, error } = pickMeeting(decision.meeting, votableMeetings(raw));
    if (error) return { ok: false, retry: false, error };
    if (meeting.votes?.[raw.selfId] === undefined) {
      return { ok: false, retry: false, error: "no vote to withdraw" };
    }
    return { ok: true, action: "unvote", meeting: meeting.name };
  }

  return { ok: false, retry: true, error: `unknown action "${decision.action}"` };
}

// --- ollama client --------------------------------------------------------

export async function ollamaChat(opts, messages, { think = false } = {}) {
  const body = {
    model: opts.model,
    messages,
    stream: false,
    format: DECISION_SCHEMA,
    keep_alive: opts.keepAlive,
    options: {
      num_ctx: opts.numCtx,
      num_predict: opts.numPredict,
      temperature: opts.temperature,
    },
  };
  if (!think) body.think = false;

  const started = Date.now();
  const res = await fetch(`${opts.ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.requestTimeout || 300000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ollama returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    // Older Ollama builds reject `think` for models without a thinking mode.
    if (!think && /think/i.test(data.error || "")) {
      delete body.think;
      const again = await fetch(`${opts.ollama}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.requestTimeout || 300000),
      });
      data = await again.json();
      if (data.error) throw new Error(`ollama: ${data.error}`);
    } else {
      throw new Error(`ollama (${res.status}): ${data.error || text.slice(0, 200)}`);
    }
  }

  const ns = (n) => (n ? n / 1e9 : 0);
  const stats = {
    wallMs: Date.now() - started,
    promptTokens: data.prompt_eval_count || 0,
    promptSec: ns(data.prompt_eval_duration),
    genTokens: data.eval_count || 0,
    genSec: ns(data.eval_duration),
  };
  stats.promptRate = stats.promptSec ? stats.promptTokens / stats.promptSec : 0;
  stats.genRate = stats.genSec ? stats.genTokens / stats.genSec : 0;

  return { content: data.message?.content || "", stats };
}

function fmtStats(s) {
  return (
    `${(s.wallMs / 1000).toFixed(1)}s total | prompt ${s.promptTokens} tok @ ${s.promptRate.toFixed(0)} tok/s` +
    ` | gen ${s.genTokens} tok @ ${s.genRate.toFixed(1)} tok/s`
  );
}

export function parseDecision(content) {
  const trimmed = String(content || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Tolerate a stray code fence or prose around the object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

// --- the loop -------------------------------------------------------------

class Harness {
  constructor(opts) {
    this.opts = opts;
    this.system = fs.readFileSync(opts.prompt, "utf8");
    this.knowledge = null;
    this.recentActions = [];
    this.lastSayAt = 0;
    this.sentTimes = [];
    this.lastTurnAt = 0;
    this.nightDoneFor = null; // phase label whose night action is settled
    this.nightTurnsFor = null;
    this.nightTurns = 0;
    this.roleDescFor = null;
    this.roleDesc = "";
    // Chars per token, re-calibrated from Ollama's own token counts after
    // every call so the tail budget tracks the real tokenizer.
    this.charsPerToken = 3.5;
  }

  /**
   * Fetch the briefing with as many chat lines as fit inside the tail budget.
   * The tail is everything after the stable prefix (system prompt + role
   * description); see DEFAULTS.tailBudget for why its size matters so much.
   */
  async briefingWithinBudget(raw, recentActions, note) {
    let n = this.opts.chat;
    for (;;) {
      const fetched = await daemon(`/state?chat=${n}`);
      const briefing = typeof fetched === "string" ? fetched : JSON.stringify(fetched);
      const tail = buildTurnPrompt({ briefing, raw, roleDesc: "", recentActions, note });
      const estTail = Math.ceil(tail.length / this.charsPerToken);
      if (estTail <= this.opts.tailBudget || n <= 3) return { briefing, chatLines: n, estTail };
      n = Math.max(3, Math.floor(n * 0.6));
    }
  }

  remember(line) {
    this.recentActions.push({ time: Date.now(), line });
    this.recentActions = this.recentActions.slice(-6);
  }

  recentLines() {
    const now = Date.now();
    return this.recentActions.map((a) => `${ago(now - a.time)}: ${a.line}`);
  }

  async roleDescription(raw) {
    const appearance = raw.selfId ? raw.knownRoles?.[raw.selfId] : null;
    if (!appearance) return "";
    if (appearance === this.roleDescFor) return this.roleDesc;
    if (!this.knowledge) {
      try {
        this.knowledge = await Knowledge.load();
      } catch (e) {
        log(`role reference unavailable (${e.message}); continuing without it`);
        this.roleDescFor = appearance;
        this.roleDesc = appearance;
        return this.roleDesc;
      }
    }
    this.roleDescFor = appearance;
    this.roleDesc = this.knowledge.describe(appearance);
    return this.roleDesc;
  }

  async dispatch(v) {
    if (isSpeechAction(v.action)) {
      // Several lines go out a few seconds apart, the way a person types
      // them. Stop at the first line the daemon refuses.
      let last;
      for (const [i, text] of v.texts.entries()) {
        if (i > 0) await sleep(2000 + Math.random() * 3000);
        const body = speechRequestBody(v.action, v.meeting, text);
        last = await daemon("/say", { method: "POST", body });
        if (!last.ok) return last;
      }
      return last;
    }
    if (v.action === "vote") {
      return daemon("/vote", { method: "POST", body: { meeting: v.meeting, target: v.target } });
    }
    if (v.action === "unvote") {
      return daemon("/unvote", { method: "POST", body: { meeting: v.meeting } });
    }
    return { ok: true, message: "waiting" };
  }

  /**
   * Turn the daemon's mention records into the note the model sees, and
   * decide whether this wake demands an action. Faction chat is read, not
   * answered line by line; everything else that names us gets an answer.
   */
  describeMentions(mentions) {
    const lines = [];
    let mustAct = false;
    for (const m of (mentions || []).slice(-3)) {
      const content = String(m.content || "").slice(0, 160);
      if (m.type === "system") {
        lines.push(`a system message (${m.kind}): "${content}"`);
        mustAct = true;
      } else if (m.type === "faction") {
        lines.push(`${m.from} in ${m.meeting || "faction chat"}: "${content}"`);
      } else if (m.hostile) {
        lines.push(`${m.from} pushed against you: "${content}"`);
        mustAct = true;
      } else {
        lines.push(`${m.from} addressed you: "${content}"`);
        mustAct = true;
      }
    }
    return { note: lines.join("; "), mustAct };
  }

  /** Names of living players currently voting us in any votable meeting. */
  votersOnMe(raw) {
    const names = new Set();
    for (const m of votableMeetings(raw)) {
      for (const [voter, target] of Object.entries(m.votes || {})) {
        if (voter === raw.selfId) continue;
        const targets = Array.isArray(target) ? target : [target];
        if (targets.includes(raw.selfId)) names.add(playerName(raw, voter));
      }
    }
    return names;
  }

  /** One model turn: brief, decide, validate, act. Returns the action taken. */
  async takeTurn(raw, reason, { mustAct = false } = {}) {
    const { opts } = this;
    this.lastTurnAt = Date.now();
    const roleDesc = await this.roleDescription(raw);

    let note = reason ? `You are acting because: ${reason}.` : "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const recentActions = this.recentLines();
      const { briefing, chatLines, estTail } = await this.briefingWithinBudget(raw, recentActions, note);
      const user = buildTurnPrompt({ briefing, raw, roleDesc, recentActions, note });
      if (opts.verbose) log(`--- prompt (attempt ${attempt + 1}) ---\n${user}\n---`);

      let result;
      try {
        result = await ollamaChat(opts, [
          { role: "system", content: this.system },
          { role: "user", content: user },
        ], { think: opts.think });
      } catch (e) {
        log(`ollama error: ${e.message}`);
        return "error";
      }
      if (result.stats.promptTokens > 100) {
        this.charsPerToken = (this.system.length + user.length) / result.stats.promptTokens;
      }
      log(`model: ${fmtStats(result.stats)} | tail ~${estTail} tok, ${chatLines} chat lines`);

      const decision = parseDecision(result.content);
      if (!decision) {
        log(`unparseable reply: ${result.content.slice(0, 200)}`);
        note = "Your previous reply was not valid JSON. Reply with one JSON object only.";
        continue;
      }
      if (decision.reason) log(`reason: ${String(decision.reason).slice(0, 200)}`);

      // A turn we were woken for shortens the pacing gap and refuses a wait
      // once, but never beats the per-minute ceiling: every mention in a
      // busy chat is a wake, and answering each with three lines is how a
      // bot outpaces every human in the game.
      const recent = this.sentTimes.filter((t) => Date.now() - t < 60000);
      const allowance = Math.max(0, opts.linesPerMinute - recent.length);
      const v = validateDecision(decision, raw, {
        lastSayAt: this.lastSayAt,
        sayGap: mustAct ? Math.min(opts.sayGap, 8000) : opts.sayGap,
        mustAct: mustAct && attempt === 0,
        maxLines: Math.min(opts.maxLines, allowance || 1),
      });
      if (v.ok && isSpeechAction(v.action) && allowance === 0) {
        log(`rate limit: ${recent.length} lines in the last minute; holding this one`);
        return "wait";
      }
      if (!v.ok) {
        log(`rejected ${decision.action}: ${v.error}`);
        if (v.retry) {
          note = `Your previous reply was rejected: ${v.error}. Choose again.`;
          continue;
        }
        return "wait";
      }

      const summary =
        v.action === "say"
          ? `said in "${v.meeting}": ${v.texts.join(" | ")}`
          : v.action === "cry"
            ? `cried anonymously in "${v.meeting}": ${v.texts.join(" | ")}`
          : v.action === "vote"
            ? `voted ${v.target} in "${v.meeting}"`
            : v.action === "unvote"
              ? `unvoted in "${v.meeting}"`
              : "waited";

      if (opts.dryRun) {
        log(`DRY RUN — would have ${summary}`);
        this.remember(`(dry run) ${summary}`);
        return v.action;
      }

      const r = await this.dispatch(v);
      if (!r.ok) {
        log(`daemon rejected ${v.action}: ${r.error}`);
        note = `The game rejected that: ${r.error}. Choose again.`;
        continue;
      }
      log(summary);
      if (isSpeechAction(v.action)) {
        this.lastSayAt = Date.now();
        for (const _ of v.texts) this.sentTimes.push(Date.now());
        this.sentTimes = this.sentTimes.slice(-20);
      }
      if (v.action !== "wait") this.remember(summary);
      if (r.digest && opts.verbose) log(r.digest);
      return v.action;
    }
    return "wait";
  }

  async run() {
    const { opts } = this;
    log(`harness up: model=${opts.model} ollama=${opts.ollama} ctx=${opts.numCtx}${opts.dryRun ? " DRY RUN" : ""}`);

    let wakeReason = "startup";
    let mustAct = false;
    let lastPhase = null;
    let votersSeen = new Set();

    for (;;) {
      let health;
      try {
        health = await daemon("/health");
      } catch (e) {
        log(`daemon unreachable: ${e.message}`);
        await sleep(5000);
        continue;
      }
      if (health.superseded) {
        log(`daemon reports we are no longer in the game: ${health.note || ""}`);
        return;
      }
      if (health.finished) {
        log("game over — harness exiting");
        return;
      }

      const raw = await daemon("/raw");
      const phase = raw.phase || health.phase || "?";
      if (phase !== lastPhase) {
        log(`phase: ${phase}`);
        if (lastPhase !== null) wakeReason = `phase changed to ${phase}`;
        lastPhase = phase;
        votersSeen = new Set();
      }

      // A vote landing on us is a wake in its own right, whatever event
      // actually fired. Compare against the voters we already knew about.
      const votersNow = this.votersOnMe(raw);
      const newVoters = [...votersNow].filter((n) => !votersSeen.has(n));
      votersSeen = votersNow;
      if (newVoters.length) {
        const line = `${newVoters.join(", ")} just voted you`;
        wakeReason = wakeReason ? `${wakeReason}; ${line}` : line;
        mustAct = true;
      }

      const isDay = /^Day\b/.test(phase);
      const isNight = /^Night\b/.test(phase);
      const dead = Boolean(raw.dead?.[raw.selfId]);
      const actionable = votableMeetings(raw).length + speakableMeetings(raw).length > 0;

      // Nothing for a model to do in pregame, when dead, or as a spectator.
      // Don't spend minutes of CPU on it.
      if (!health.started || dead || raw.isSpectator || !actionable) {
        // Say why, once per phase, or a quiet night looks like a hung harness.
        const why = !health.started
          ? "pregame; waiting for the game to start"
          : dead
            ? "we are dead; idling until the game ends"
            : raw.isSpectator
              ? "spectating; nothing to do"
              : `no meeting to act in during ${phase}; idling until something happens`;
        if (this.idleNoteFor !== `${phase}:${why}`) {
          this.idleNoteFor = `${phase}:${why}`;
          const role = raw.selfId ? raw.knownRoles?.[raw.selfId] : null;
          log(`${why}${role ? ` (role: ${role})` : ""}`);
        }
        await this.block(120000);
        wakeReason = "";
        continue;
      }

      const sinceTurn = Date.now() - this.lastTurnAt;
      let due = false;
      if (wakeReason) due = true;
      else if (isDay && sinceTurn >= opts.cadence) due = true;
      else if (isNight && this.nightDoneFor !== phase) due = true;
      else if (!isDay && !isNight && sinceTurn >= opts.cadence) due = true;

      if (due) {
        const fallback = isDay
          ? "it is your turn to contribute"
          : isNight
            ? "you have not chosen your night action yet"
            : "";
        const took = await this.takeTurn(raw, wakeReason || fallback, { mustAct });
        mustAct = false;
        if (isNight && took !== "error") {
          // Talking in a night meeting is fine, but it must not stand in for
          // the night action: keep taking turns until a vote (or an explicit
          // wait) lands, with a cap so a chatty model cannot loop all night.
          this.nightTurns = this.nightTurnsFor === phase ? this.nightTurns + 1 : 1;
          this.nightTurnsFor = phase;
          const settled =
            took === "vote" || took === "wait" || !votableMeetings(raw).length || this.nightTurns >= 3;
          if (settled) this.nightDoneFor = phase;
        }
        wakeReason = "";
      }

      // Block until something happens. Nights are short and we've acted, so
      // hold until the phase turns; days poll on the cadence so we keep
      // talking even when nobody addresses us. A night action still pending
      // gets another turn almost immediately.
      const left = timeLeft(raw);
      let waitMs = opts.cadence;
      if (isNight && this.nightDoneFor === phase) waitMs = Math.min(300000, (left ?? 120000) + 5000);
      else if (isNight) waitMs = 2000;
      const r = await this.block(waitMs);
      if (r?.firedOn === "mention") {
        const described = this.describeMentions(r.newMentions);
        wakeReason = described.note || "someone mentioned you";
        mustAct = described.mustAct;
      } else if (r?.firedOn === "finished") wakeReason = "game finished";
      else wakeReason = ""; // phase changes and votes are detected at the top of the loop
    }
  }

  async block(waitMs) {
    try {
      return await daemon(
        `/wait?events=state,mention,finished,vote,unvote&timeout=${Math.max(1000, waitMs)}&consume=false`,
        { timeoutMs: waitMs + 10000 }
      );
    } catch (e) {
      log(`wait failed: ${e.message}`);
      await sleep(3000);
      return null;
    }
  }
}

// --- bench ----------------------------------------------------------------

/**
 * Measure prompt-processing and generation speed on this machine with a
 * prompt the size of a real turn. Run before the first game so the cadence
 * and context settings can be tuned to what the CPU can actually do.
 */
async function bench(opts) {
  const system = fs.readFileSync(opts.prompt, "utf8");
  const names = ["alice", "bob", "carol", "dave", "erin", "frank", "grace"];
  const chat = [];
  for (let i = 0; i < opts.chat; i++) {
    const who = names[i % names.length];
    chat.push(`  [12:0${i % 10}] {Village} ${who}: ${["any reads yet", "i think frank is scummy", "vote bob", "why me", "cop claim?", "wait for flips"][i % 6]} ${i}`);
  }
  const briefing = [
    "════ UltiMafia · Game bench123 [COMPACT] ════",
    "Phase: Day 2 (6m 12s left) | Alive: 6/7",
    "YOU: erin (id=p5) | Role: Villager",
    "Alive (6): alice, bob, carol, dave, erin [YOU], frank",
    "Dead (1): grace (Cop)",
    "",
    "── VOTES ──",
    '* "Village": bob=2, frank=1 | cast 3/6 | yours: (not cast)',
    "",
    "── REPORTS (1 in Day 2) ──",
    "  [12:00] grace was condemned. grace was a Cop.",
    "",
    `── CHAT (last ${opts.chat}) ──`,
    ...chat,
  ].join("\n");
  const raw = {
    selfId: "p5",
    players: Object.fromEntries(names.map((n, i) => [`p${i}`, { id: `p${i}`, name: n }])),
    meetings: {
      m1: { id: "m1", name: "Village", amMember: true, voting: true, canVote: true, speech: true, canTalk: true,
        targets: ["p0", "p1", "p2", "p3", "p5", "*"], votes: { p0: "p1", p2: "p1", p3: "p5" } },
    },
    messages: [],
  };
  const user = buildTurnPrompt({ briefing, raw, roleDesc: "Villager — Village\n  No special abilities.", recentActions: ["70s ago: said in \"Village\": leaning bob"] });

  const est = (s) => Math.round(s.length / 3.5);
  console.log(
    `model ${opts.model} via ${opts.ollama}; prompt ~${est(system) + est(user)} tokens` +
      ` (system ~${est(system)}, changing tail ~${est(user)}; tail budget ${opts.tailBudget})`
  );
  // The second call changes the board the way a real turn does, so only the
  // system prompt can be served from cache. An identical prompt would be
  // cached wholesale and report a speed no live turn ever sees.
  const user2 = user.replace("cast 3/6", "cast 4/6").replace("(no new messages)", "") +
    "\n\n(alice just said: erin you have been quiet, thoughts?)";
  const runs = [
    ["cold (loads model, no cache)", user],
    ["warm (system prompt cached, new board)", user2],
  ];
  for (const [label, content] of runs) {
    const r = await ollamaChat(opts, [
      { role: "system", content: system },
      { role: "user", content },
    ], { think: opts.think });
    console.log(`${label}: ${fmtStats(r.stats)}`);
    console.log(`  reply: ${r.content.trim().slice(0, 200)}`);
  }
  console.log(
    "\nThe warm line is what a live turn costs. A night phase is 120s; keep it well under that.\n" +
      "If the warm prompt rate is no better than the cold one, the cache was not reused: the changing\n" +
      "tail is too long for the model's checkpoint window. Lower --chat or --tail-budget."
  );
}

// --- entrypoint -----------------------------------------------------------

function optionsFrom(flags) {
  const num = (k, d) => (flags[k] !== undefined ? Number(flags[k]) : d);
  return {
    model: flags.model || DEFAULTS.model,
    ollama: (flags.ollama || DEFAULTS.ollama).replace(/\/$/, ""),
    prompt: flags.prompt ? path.resolve(flags.prompt) : DEFAULTS.prompt,
    chat: num("chat", DEFAULTS.chat),
    tailBudget: num("tail-budget", DEFAULTS.tailBudget),
    cadence: num("cadence", DEFAULTS.cadence),
    sayGap: num("say-gap", DEFAULTS.sayGap),
    maxLines: num("max-lines", DEFAULTS.maxLines),
    linesPerMinute: num("lines-per-minute", DEFAULTS.linesPerMinute),
    numCtx: num("num-ctx", DEFAULTS.numCtx),
    // Thinking models write a couple of thousand tokens before the JSON; a
    // small cap silently truncates them to an empty reply.
    numPredict: num("num-predict", flags.think ? 4000 : DEFAULTS.numPredict),
    temperature: num("temperature", DEFAULTS.temperature),
    keepAlive: flags["keep-alive"] || DEFAULTS.keepAlive,
    think: Boolean(flags.think),
    dryRun: Boolean(flags["dry-run"]),
    verbose: Boolean(flags.verbose),
  };
}

const USAGE = `usage: node src/agent.js [options]

Attach a local Ollama model to the running daemon (start one with "um join <gameId>").

  --model <name>        Ollama model tag (default ${DEFAULTS.model})
  --ollama <url>        Ollama base URL (default ${DEFAULTS.ollama})
  --prompt <file>       system prompt (default prompts/local-agent.md)
  --chat <n>            max chat lines per turn (default ${DEFAULTS.chat})
  --tail-budget <n>     max tokens in the changing part of the prompt (default ${DEFAULTS.tailBudget})
  --cadence <ms>        proactive day turn interval (default ${DEFAULTS.cadence})
  --say-gap <ms>        minimum gap between own speaking turns (default ${DEFAULTS.sayGap})
  --max-lines <n>       chat lines one turn may send, staggered (default ${DEFAULTS.maxLines})
  --lines-per-minute <n> hard ceiling on chat lines per minute (default ${DEFAULTS.linesPerMinute})
  --num-ctx <n>         context window (default ${DEFAULTS.numCtx})
  --num-predict <n>     max generated tokens (default ${DEFAULTS.numPredict})
  --temperature <x>     sampling temperature (default ${DEFAULTS.temperature})
  --think               allow the model's thinking mode (slow on CPU)
  --dry-run             decide but never send anything to the game
  --verbose             print every prompt and digest
  --bench               measure prompt/generation speed, then exit
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }
  const opts = optionsFrom(flags);
  if (!fs.existsSync(opts.prompt)) {
    console.error(`system prompt not found: ${opts.prompt}`);
    process.exit(1);
  }
  if (flags.bench) return bench(opts);

  const harness = new Harness(opts);
  await harness.run();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
