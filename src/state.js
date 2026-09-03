// Reduces the raw socket event stream into a coherent picture of the game.
//
// The server is authoritative and pushes deltas, so this is a straight fold
// over events. Anything not understood is still recorded in the event log,
// so nothing is silently lost.

export class GameState {
  constructor(gameId) {
    this.gameId = gameId;

    this.selfId = null;
    this.players = {}; // playerId -> {id, name, userId, playerListPosition}
    this.setup = null;
    this.options = null;

    this.stateInfo = { name: "Pregame", id: -1, dayCount: 0 };
    this.stateEvents = [];
    this.history = {}; // stateId -> {name, meetings, alerts, roles, dead, ...}
    this.meetings = {}; // live meetings for the current state, by meeting id

    this.messages = new Map(); // messageId -> message (deduped across sources)
    this.reveals = {}; // playerId -> "Role:Mods" learned privately
    this.liveDead = {}; // playerId -> bool, from death/revival broadcasts
    this.exorcised = {}; // playerId -> bool
    this.obituaries = new Map(); // obituary id -> payload
    this.timers = {}; // timerName -> {delay, time, receivedAt}

    this.started = false;
    this.finished = false;
    this.winners = null;
    this.loaded = false;
    this.connected = false;
    this.leftGame = false;
    this.isSpectator = false;
    this.lastWill = "";

    this.errors = [];
    this.log = []; // full ordered event log
    this.unknownEvents = new Set();
  }

  // --- derived views ------------------------------------------------------

  get currentStateId() {
    return this.stateInfo?.id ?? -1;
  }

  /** "Day 2" / "Night 1" / "Pregame" */
  get phaseLabel() {
    const name = this.stateInfo?.name || "?";
    const day = this.stateInfo?.dayCount;
    // The server sometimes sends the name already numbered ("Night 1"); do
    // not turn that into "Night 1 1".
    if (day && name !== "Pregame" && name !== "Postgame" && !/\d\s*$/.test(name)) {
      return `${name} ${day}`;
    }
    return name;
  }

  get self() {
    return this.selfId ? this.players[this.selfId] : null;
  }

  /**
   * Everything this client has been told about who is what, folded across all
   * states. Includes own role, faction partners (revealed at role assignment),
   * investigation results and flips.
   */
  knownRoles() {
    const known = {};
    const stateIds = Object.keys(this.history)
      .map(Number)
      .sort((a, b) => a - b);
    for (const sid of stateIds) {
      Object.assign(known, this.history[sid].roles || {});
    }
    Object.assign(known, this.reveals);
    return known;
  }

  deadMap() {
    const dead = {};
    const stateIds = Object.keys(this.history)
      .map(Number)
      .sort((a, b) => a - b);
    for (const sid of stateIds) {
      Object.assign(dead, this.history[sid].dead || {});
    }
    // History is only re-sent on (re)connect; deaths arrive live as broadcasts.
    Object.assign(dead, this.liveDead);
    return dead;
  }

  alivePlayers() {
    const dead = this.deadMap();
    return Object.values(this.players).filter((p) => !dead[p.id] && !p.left);
  }

  /** Server-authored messages: cop reports, flips, obituaries, system notices. */
  systemMessages() {
    const out = [];
    for (const m of this.messages.values()) {
      if (m.senderId === "server") out.push(m);
    }
    return out.sort((a, b) => (a.time || 0) - (b.time || 0));
  }

  chatMessages() {
    const out = [];
    for (const m of this.messages.values()) {
      if (m.senderId !== "server") out.push(m);
    }
    return out.sort((a, b) => (a.time || 0) - (b.time || 0));
  }

  allMessages() {
    return [...this.messages.values()].sort((a, b) => (a.time || 0) - (b.time || 0));
  }

  /** Meetings this client can currently act in. */
  actionableMeetings() {
    return Object.values(this.meetings).filter(
      (m) => m.amMember && ((m.voting && m.canVote) || (m.speech && m.canTalk))
    );
  }

  votableMeetings() {
    return Object.values(this.meetings).filter(
      (m) => m.amMember && m.voting && m.canVote
    );
  }

  speakableMeetings() {
    return Object.values(this.meetings).filter(
      (m) => m.amMember && m.speech && m.canTalk
    );
  }

  /** Resolve a user-typed meeting hint to exactly one meeting, or explain why not. */
  resolveMeeting(hint, pool) {
    const candidates = pool || Object.values(this.meetings).filter((m) => m.amMember);

    if (!hint) {
      if (candidates.length === 1) return { meeting: candidates[0] };
      return {
        error:
          candidates.length === 0
            ? "No meeting is available to act in right now."
            : `Ambiguous — specify --meeting. Options: ${candidates
                .map((m) => `"${m.name}"`)
                .join(", ")}`,
      };
    }

    const lower = String(hint).toLowerCase();
    let matches = candidates.filter((m) => m.id === hint);
    if (!matches.length) {
      matches = candidates.filter((m) => (m.name || "").toLowerCase() === lower);
    }
    if (!matches.length) {
      matches = candidates.filter((m) =>
        (m.name || "").toLowerCase().includes(lower)
      );
    }

    if (matches.length === 1) return { meeting: matches[0] };
    if (matches.length === 0) {
      return {
        error: `No meeting matching "${hint}". Available: ${
          candidates.map((m) => `"${m.name}"`).join(", ") || "(none)"
        }`,
      };
    }
    return {
      error: `"${hint}" is ambiguous: ${matches.map((m) => `"${m.name}"`).join(", ")}`,
    };
  }

  /**
   * Resolve a target the way a human would type it — player name, player id,
   * "no one"/"skip" for the abstain target, or a literal option like "Yes".
   * Always validated against the meeting's own `targets` list, which is the
   * server's source of truth for what is legal.
   */
  resolveTarget(meeting, input) {
    const targets = Array.isArray(meeting.targets) ? meeting.targets : [];
    const raw = String(input).trim();
    const lower = raw.toLowerCase();

    if (meeting.inputType === "text") return { target: raw };

    if (["*", "no one", "noone", "none", "skip", "abstain"].includes(lower)) {
      if (targets.includes("*")) return { target: "*" };
      return { error: `This meeting does not allow abstaining. Targets: ${this.describeTargets(meeting)}` };
    }

    // Exact id / literal option (e.g. "Yes", a role name).
    if (targets.includes(raw)) return { target: raw };
    const ci = targets.find((t) => String(t).toLowerCase() === lower);
    if (ci) return { target: ci };

    // Player name -> player id, restricted to legal targets.
    const byName = Object.values(this.players).filter(
      (p) => (p.name || "").toLowerCase() === lower
    );
    const byPrefix = Object.values(this.players).filter((p) =>
      (p.name || "").toLowerCase().startsWith(lower)
    );
    const pool = byName.length ? byName : byPrefix;
    const legal = pool.filter((p) => targets.includes(p.id));

    if (legal.length === 1) return { target: legal[0].id };
    if (legal.length > 1) {
      return {
        error: `"${raw}" is ambiguous: ${legal.map((p) => p.name).join(", ")}`,
      };
    }

    if (pool.length) {
      return {
        error: `${pool[0].name} is not a legal target for "${meeting.name}". Legal: ${this.describeTargets(meeting)}`,
      };
    }

    return { error: `No target matching "${raw}". Legal: ${this.describeTargets(meeting)}` };
  }

  describeTargets(meeting) {
    const targets = Array.isArray(meeting.targets) ? meeting.targets : [];
    if (!targets.length) return "(none)";
    return targets.map((t) => this.targetLabel(t, meeting)).join(", ");
  }

  targetLabel(target, meeting) {
    if (target === "*") return meeting?.noOneDisplayName || "No One (*)";
    if (target === "*magus") return "Magus (*magus)";
    const p = this.players[target];
    return p ? p.name : String(target);
  }

  playerName(id) {
    if (id === "server") return "SYSTEM";
    if (id === "anonymous") return "Anonymous";
    return this.players[id]?.name || id;
  }

  /** Milliseconds left on a timer, decayed from when we last heard about it. */
  timeLeft(name) {
    const t = this.timers[name];
    if (!t || t.delay == null || t.time == null) return null;
    const elapsedSinceUpdate = Date.now() - t.receivedAt;
    return Math.max(0, t.delay - t.time - elapsedSinceUpdate);
  }

  /** The timer governing the current phase, whichever it happens to be. */
  primaryTimer() {
    const preferred = ["main", "pregameWait", "pregameCountdown", "secondary"];
    for (const name of preferred) {
      if (this.timers[name]) return { name, left: this.timeLeft(name) };
    }
    const first = Object.keys(this.timers)[0];
    return first ? { name: first, left: this.timeLeft(first) } : null;
  }

  // --- event fold ---------------------------------------------------------

  apply(eventName, data) {
    this.log.push({ t: Date.now(), event: eventName, data });
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);

    switch (eventName) {
      case "p":
        break;

      case "connected":
        this.connected = true;
        break;

      case "loaded":
        this.loaded = true;
        break;

      case "self":
        this.selfId = data;
        break;

      case "players":
        this.players = data || {};
        break;

      case "playerJoin":
        if (data && data.id) this.players[data.id] = data;
        break;

      case "isSpectator":
        // Sent when the server seats you as a spectator instead of a player —
        // e.g. you joined a game that filled while you were connecting. Easy
        // to miss, and it means you are NOT playing.
        this.isSpectator = data === undefined ? true : Boolean(data);
        break;

      case "playerLeave":
        // The `players` payload isn't re-sent on leave, so flag it here or the
        // player list keeps showing them as seated.
        if (data && this.players[data]) this.players[data].left = true;
        break;

      case "setup":
        this.setup = data;
        break;

      case "options":
        this.options = data;
        break;

      case "isStarted":
        // Sent payload-less when the server-side value is undefined, so a bare
        // frame must not be read as "true".
        this.started = Boolean(data);
        break;

      case "history":
        this.history = data || {};
        this.seedFromHistory();
        break;

      case "state": {
        const previousStateId = this.currentStateId;
        this.stateInfo = data || this.stateInfo;
        if (this.stateInfo?.name && this.stateInfo.name !== "Pregame") {
          this.started = true;
        }
        // Meetings are scoped to a state, so drop stale ones on a real phase
        // change and let the server resend. On the initial burst the server
        // sends `history` (which seeds meetings) BEFORE `state` for the same
        // state id — clearing unconditionally would throw those away.
        if (previousStateId !== this.currentStateId) this.meetings = {};
        // Re-seed from history for the state we just learned we're in. On a
        // mid-game reconnect `history` arrives while currentStateId is still
        // the -1 default, so seeding there drops every live meeting.
        for (const m of Object.values(
          this.history[this.currentStateId]?.meetings || {}
        )) {
          this.meetings[m.id] = m;
          this.absorbMeetingMessages(m);
        }
        if (!this.history[this.currentStateId]) {
          this.history[this.currentStateId] = {
            name: data?.name,
            meetings: {},
            alerts: [],
            roles: {},
            dead: {},
            stateEvents: [],
          };
        }
        break;
      }

      case "stateEvents":
        this.stateEvents = data || [];
        break;

      case "meeting":
        if (data && data.id) this.meetings[data.id] = data;
        this.absorbMeetingMessages(data);
        break;

      case "leftMeeting":
        delete this.meetings[data];
        break;

      case "members":
        if (data && this.meetings[data.meetingId]) {
          this.meetings[data.meetingId].members = data.members;
        }
        break;

      case "message":
        this.addMessage(data);
        break;

      case "quote":
        this.addMessage(data);
        break;

      case "vote":
        this.applyVote(data);
        break;

      case "unvote":
        this.applyUnvote(data);
        break;

      case "reveal":
      case "roleReveal":
        if (data && data.playerId) this.reveals[data.playerId] = data.role;
        break;

      case "death":
        if (data) this.liveDead[data] = true;
        break;

      case "revival":
        if (data) this.liveDead[data] = false;
        break;

      case "exorcised":
        if (data) {
          this.liveDead[data] = true;
          this.exorcised[data] = true;
        }
        break;

      case "obituaries":
        if (data && data.id) this.obituaries.set(data.id, data);
        break;

      case "timerInfo":
        if (data && data.name) {
          this.timers[data.name] = {
            ...(this.timers[data.name] || {}),
            delay: data.delay,
            time: this.timers[data.name]?.time ?? 0,
            receivedAt: Date.now(),
          };
        }
        break;

      case "time":
        if (data && data.name) {
          this.timers[data.name] = {
            ...(this.timers[data.name] || {}),
            time: data.time,
            receivedAt: Date.now(),
          };
        }
        break;

      case "clearTimer":
        delete this.timers[data];
        break;

      case "lastWill":
        this.lastWill = data || "";
        break;

      case "finished":
        this.finished = true;
        break;

      case "left":
      case "gameLeft":
        this.leftGame = true;
        break;

      case "error":
      case "gameLeaveError":
      case "banned":
        this.errors.push({ t: Date.now(), message: String(data ?? eventName) });
        break;

      // Cosmetic / not needed for play.
      case "typing":
      case "emojis":
      case "dev":
      case "firstGame":
      case "spectatorCount":
      case "spectators":
      case "audio":
      case "speakCooldown":
      case "authSuccess":
      case "youAreBeingVoteKicked":
      case "hostId":
      case "readyCheck init":
      case "readyCheck update":
      case "readyCheck success":
      case "readyCheck cancel":
        break;

      default:
        this.unknownEvents.add(eventName);
        break;
    }
  }

  seedFromHistory() {
    for (const sid of Object.keys(this.history)) {
      const st = this.history[sid];
      for (const alert of st.alerts || []) this.addMessage(alert);
      for (const ob of Object.values(st.obituaries || {})) {
        if (ob && ob.id) this.obituaries.set(ob.id, ob);
      }
      for (const m of Object.values(st.meetings || {})) {
        this.absorbMeetingMessages(m);
        if (Number(sid) === this.currentStateId) this.meetings[m.id] = m;
      }
      if (st.winners) this.winners = st.winners;
    }
  }

  absorbMeetingMessages(meeting) {
    if (!meeting || !Array.isArray(meeting.messages)) return;
    for (const m of meeting.messages) this.addMessage(m);
  }

  addMessage(message) {
    if (!message) return;

    // Quotes reference an earlier message by id instead of carrying content,
    // so resolve the original rather than rendering `undefined`.
    if (message.isQuote) {
      const original = this.messages.get(message.messageId);
      const id = `q-${message.senderId}-${message.messageId}-${message.time}`;
      if (this.messages.has(id)) return;
      this.messages.set(id, {
        ...message,
        meetingId: message.toMeetingId,
        content: original
          ? `[quoting ${this.playerName(original.senderId)}] "${original.content}"`
          : "[quoted an earlier message]",
        stateId: this.currentStateId,
        stateName: this.phaseLabel,
      });
      return;
    }

    if (message.content === undefined) return;

    const id = message.id || `${message.time}-${message.senderId}-${message.content}`;
    if (this.messages.has(id)) return;
    this.messages.set(id, {
      ...message,
      stateId: message.stateId ?? this.currentStateId,
      stateName: this.phaseLabel,
    });
  }

  applyVote(data) {
    if (!data || !data.meetingId) return;
    const meeting = this.meetings[data.meetingId];
    if (!meeting) return;
    meeting.votes = meeting.votes || {};
    if (meeting.multi) {
      meeting.votes[data.voterId] = meeting.votes[data.voterId] || [];
      if (!meeting.votes[data.voterId].includes(data.target)) {
        meeting.votes[data.voterId].push(data.target);
      }
    } else {
      meeting.votes[data.voterId] = data.target;
    }
  }

  applyUnvote(data) {
    if (!data || !data.meetingId) return;
    const meeting = this.meetings[data.meetingId];
    if (!meeting || !meeting.votes) return;
    if (meeting.multi && Array.isArray(meeting.votes[data.voterId])) {
      meeting.votes[data.voterId] = meeting.votes[data.voterId].filter(
        (t) => t !== data.target
      );
    } else {
      delete meeting.votes[data.voterId];
    }
  }
}
