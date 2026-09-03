// Thin wrapper over the UltiMafia REST API.
//
// Auth is a session cookie. Every non-GET request must carry the `x-csrf`
// header (see modules/csrf.js upstream) or the server answers a bare 403.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig() {
  const file = path.join(ROOT, "config.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file}. Copy config.example.json to config.json and fill in your cookie + csrf.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export class UMRest {
  constructor(config = loadConfig()) {
    this.baseUrl = (config.baseUrl || "https://ultimafia.com").replace(/\/$/, "");
    this.cookie = config.cookie;
    this.csrf = config.csrf;
  }

  async request(method, endpoint, body) {
    const url = `${this.baseUrl}/api${endpoint}`;
    const headers = { Cookie: this.cookie, Accept: "application/json" };

    if (method !== "GET") {
      headers["x-csrf"] = this.csrf;
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get(endpoint) {
    return this.request("GET", endpoint);
  }

  post(endpoint, body = {}) {
    return this.request("POST", endpoint, body);
  }

  // --- specific endpoints -------------------------------------------------

  whoami() {
    return this.get("/user/info");
  }

  /** list: "all" | "open" | "in progress"; lobby: "Main" | "Sandbox" | ... | "All" */
  listGames({ list = "all", lobby = "All", page = 1 } = {}) {
    return this.get(
      `/game/list?list=${encodeURIComponent(list)}&lobby=${encodeURIComponent(
        lobby
      )}&page=${page}`
    );
  }

  gameInfo(gameId) {
    return this.get(`/game/${gameId}/info`);
  }

  /**
   * Hands back {port, type, token, hostId}. The token is single-use and
   * short-lived, so fetch it immediately before dialing the socket.
   */
  connectInfo(gameId, spectate = false) {
    spectate = true;
    return this.get(`/game/${gameId}/connect${spectate ? "?spectate=true" : ""}`);
  }

  leaveGame() {
    return this.post("/game/leave", {});
  }

  /**
   * Creates a game and returns its id. The server rejects ranked games that
   * are private, competitive, or allow guests, and rejects setups that aren't
   * approved for ranked — so those are validated before calling.
   * `stateLengths` values are in MINUTES.
   */
  hostGame({
    setup,
    gameType = "Mafia",
    lobby = "Main",
    lobbyName,
    ranked = false,
    competitive = false,
    isPrivate = false,
    guests = false,
    spectating = true,
    readyCheck = true,
    noVeg = false,
    stateLengths = { Day: 10, Night: 2 },
    pregameWaitLength = 1,
    extendLength = 3,
  }) {
    // pregameWaitLength (hours, 1-6) and extendLength (minutes, 0-5) MUST be
    // sent. The server runs them through Number() and only rejects values
    // outside the range — NaN fails both comparisons, so omitting them passes
    // validation and yields a NaN pregame timer that fires immediately,
    // closing the game about 30 seconds after it is created.
    return this.post("/game/host", {
      setup,
      gameType,
      lobby,
      lobbyName,
      ranked,
      competitive,
      private: isPrivate,
      guests,
      spectating,
      readyCheck,
      noVeg,
      stateLengths,
      pregameWaitLength,
      extendLength,
    });
  }

  /** Search setups by name. Returns {setups, pages}. */
  searchSetups(query, gameType = "Mafia") {
    return this.get(
      `/setup/search?gameType=${encodeURIComponent(gameType)}&query=${encodeURIComponent(query)}`
    );
  }

  setup(setupId) {
    return this.get(`/setup/${setupId}`);
  }

  /** Player-written setup guides from the Strategy area. */
  strategies(setupId) {
    return this.get(`/strategy?setupId=${encodeURIComponent(setupId)}`);
  }

  rolesRaw() {
    return this.get("/roles/raw");
  }

  modifiers() {
    return this.get("/roles/modifiers");
  }

  roleTags() {
    return this.get("/roles/roletags");
  }

  gameSettings() {
    return this.get("/roles/gamesettings");
  }
}
