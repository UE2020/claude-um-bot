# um — an UltiMafia client for LLM agents

A command-line client for [UltiMafia](https://ultimafia.com), a live chat mafia
site, built so that an **LLM agent** can read a game's full state and take every
action a human player can.

There is no model API in here. The client renders the game as text and executes
decisions; whatever agent is reading the terminal does the reasoning. It was
written and tested with Claude Code, but nothing is harness-specific — any agent
that can run a shell command and read its output can play.

**If you are an agent about to use this, read [`AGENTS.md`](AGENTS.md) first.**
It covers the operating loop, the wake-up requirement (phases run on 2-minute
night timers), and the conduct rules.

> Check with the site's moderators before running an agent on UltiMafia. The
> account this was developed on had permission.

## Why it's shaped this way

A CLI process can't hold a WebSocket open between invocations. So `um join`
spawns a **daemon** that owns the socket, folds the event stream into a game
state, and exposes a small HTTP control API on `127.0.0.1`. Every other command
is a thin client against that daemon.

```
  um <cmd>  ──http──▶  daemon  ──wss──▶  ultimafia.com/3010
                          │
                          └── REST ────▶  ultimafia.com/api/*
```

## Setup

```bash
npm install
cp config.example.json config.json   # then fill in cookie + csrf
```

`config.json`:

```json
{
  "baseUrl": "https://ultimafia.com",
  "socketUrl": "wss://ultimafia.com",
  "cookie": "connect.sid=...",
  "csrf": "..."
}
```

The cookie is the `connect.sid` session cookie. `csrf` is the value the site
sends as the `x-csrf` header — every non-GET request needs it or the server
returns a bare `403 Forbidden`.

## Commands

Reference and lobby (no game connection needed):

```bash
node src/cli.js whoami
node src/cli.js lobby [--list all|open|"in progress"] [--lobby Main|Sandbox|All]
node src/cli.js setup  <setupId|gameId>   # every role in play, with descriptions
node src/cli.js guides <setupId|gameId>   # setup + player-written strategy guides
node src/cli.js role   <RoleName>         # one role's description and night order
node src/cli.js rules                     # primer on UltiMafia mechanics
```

Playing:

```bash
node src/cli.js join <gameId>        # joins as a PLAYER, starts the daemon
node src/cli.js spectate <gameId>    # for full/in-progress games
node src/cli.js state [--chat N]     # the briefing — read this before acting
node src/cli.js say "..." [--meeting M]
node src/cli.js vote <target> [--meeting M]
node src/cli.js unvote [--meeting M]
node src/cli.js will "..."
node src/cli.js raw                  # same state as JSON
node src/cli.js watch [--since N]    # raw socket event log
node src/cli.js status
node src/cli.js leave                # leave the game and stop the daemon
node src/cli.js stop                 # stop the daemon without leaving
```

## What `um state` gives you

One screen with everything needed to make a move:

- phase (`Day 2` / `Night 1`), the live phase timer, and setup flags
- your role with its **exact in-game description** and night order, plus every
  modifier's description
- the player list with alive/dead and every role you've been told about
- **faction partners and their roles** (revealed at role assignment)
- all system messages — cop reports, oracle reveals, stalker reports, flips,
  obituaries
- every active meeting: legal targets, current votes, a running tally, and
  where your own vote sits
- the exact commands available to you right now

## Actions return what changed

`say`, `vote`, `unvote` and `wait` all return a **digest** — new messages since
your last look, the live vote tally with `cast N/M`, and warnings if the phase
can resolve on the next vote or if you are the plurality leader.

This exists because acting and observing used to be two round trips. Composing a
message takes seconds, and the game moves in that window — in one game a careful
request for the Bleeder to claim went out moments *after* they had already
claimed. Now every action tells you what happened while you were deciding, so
you never act on a stale board.

## Design notes

**Everything is a meeting.** UM has no separate night-action API. The day vote,
the mafia kill, a cop check and a yes/no prompt are all Meetings you `vote` in.
`um vote` resolves targets against the meeting's own `targets` list, which is
the server's source of truth — an illegal selection is silently dropped by the
server, so it's rejected client-side with the legal list shown instead.

**Target resolution** accepts what a human would type: a player name (exact or
unique prefix), a player id, `"no one"`/`"skip"` for the abstain target `*`, or
a literal option like `Yes`. Meeting names match case-insensitively by substring.

**Joining an open game seats you as a player.** There is no spectate flag on
`join` — the server only makes you a spectator if the game is already full or
started. Don't connect to a game you don't intend to play.

**Ready checks are auto-confirmed.** A filled game kicks anyone who hasn't
readied before the countdown expires; since joining implies intent to play, the
daemon answers immediately.

Protocol details are documented in `src/wire.js`; game conventions this client
assumes are written up in `docs/UM_RULES.md`.

## Repository layout

```
src/cli.js        command line front end
src/daemon.js     owns the WebSocket, serves the local control API
src/state.js      folds the socket event stream into a game state
src/render.js     renders that state into a readable briefing
src/knowledge.js  role/modifier reference data, cached from the site
src/wire.js       the socket framing (documented — it is not socket.io)
src/rest.js       REST endpoints
src/mentions.js   detecting when someone is talking to you
data/role-notes.json  corrections for roles whose descriptions mislead
docs/UM_RULES.md  how UltiMafia actually works — read this
docs/GLOSSARY.md  site jargon (blue, uncced, MYLO, OGI, GRS…)
test/             offline tests: npm test
```

## Caveats

- One daemon, one game at a time.
- The daemon reconnects with backoff and re-fetches a fresh auth token each
  time (tokens expire within seconds).
- Nothing here plays *for* you. It surfaces state and executes decisions; the
  reasoning is the operator's. Games are ~15 minutes with 10-minute days, so
  poll `um state` while a game is live — vegging gets you kicked and penalized.
