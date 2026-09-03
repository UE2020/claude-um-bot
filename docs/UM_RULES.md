# How UltiMafia games actually work

Read this before playing. It covers the things that differ from generic mafia
and the things that will make you misplay if you assume wrong.

## Game shape

- Games are ~15 minutes. Default phase lengths are Day 10 minutes, Night 2
  minutes, but the setup can override them (`options.stateLengths`).
- A setup is **daystart or nightstart**. For Mafia this is decided by
  `gameSettings["Day Start"]`, **not** by `setup.startState` — the engine
  overwrites that field, so it is stale decoration and will lie to you
  (Hollywood Illusion advertises "Night" but is daystart). `um setup` and
  `um state` now compute it correctly. A nightstart game means power roles act
  before any discussion has happened.
- Some setups add extra phases: Dusk, Dawn, Prologue, Epilogue. `setup.dawn`
  and the state name tell you which phase you are in.
- Village wins by eliminating all Mafia (and any other hostile faction).
  Mafia wins when they reach parity — half or more of the living players.

## Condemnation is plurality, NOT majority

**The player with the most votes at the end of the day is condemned, even with
2 votes against everyone else's 1.** There is no majority threshold and no
"no-lynch by default". This is the single most important mechanical difference
from most mafia implementations.

Consequences:

- A stray vote left on someone at end of day can kill them. Always know where
  your vote is sitting. `um state` prints `YOUR VOTE:` for every voting meeting.
- Ties are broken by the game (typically no condemn, or randomized if the setup
  says so) — do not rely on a tie saving anyone.
- If the setup has `mustCondemn`, abstaining ("No One" / `*`) is not offered.

## The phase can end INSTANTLY — this is how you get blitzed

A voting meeting becomes `ready` when **every eligible voter has voted AND
there is a single plurality leader** (no tie). The moment all Important
meetings are ready, the server calls `gotoNextState()` — the phase ends right
then, with no further discussion. Verified in `Meeting.get ready` and
`Game.checkAllMeetingsReady` upstream.

Practical consequences, in order of how badly they bite:

1. **If a wagon is on you and everyone else has voted, you are one vote from
   death** with no chance to argue. The last voter decides the game.
2. **Unvoting is a defensive tool.** Removing your vote makes
   `votesCast < totalVoters`, so the meeting can never be `ready`, so the phase
   *cannot* end early. If you are the plurality leader and need talking time,
   **unvote first, argue second.** Do not sit parked on a vote while you're on
   the block.
3. A **tie also blocks** resolution (`hasPlurality` is false), which is why
   split votes run the clock out into a no-condemn.
4. Conversely, when town has decided, the last voter should deliberately create
   the plurality to end the day before mafia can react.

`um state` prints `votes cast: N/M` for every voting meeting and warns you
explicitly when the phase is one vote from resolving or when *you* are the
current plurality leader. Read those lines every single time.

## Hammering with clears and the LYLO Self-Vote convention

When the game contains a **clear** (a player confirmed innocent to everyone —
e.g. a flipped-and-confirmed cop's target, a revealed Mayor-type, a role that
proves itself), the standard endgame convention is:

1. Everyone votes in a configuration that puts **exactly one vote on every
   unclear player** — usually by voting themselves.
2. The clear then casts the deciding vote onto whoever the town wants dead.
3. Because plurality decides instantly once the day ends — and because the clear
   breaks the 1-1-1 symmetry — that player is condemned. This "hammer" resolves
   the day immediately rather than waiting out the timer.

So if you are the clear: vote last, and your vote is the decision. If you are
not the clear: put your vote where the hammer configuration needs it (normally
on yourself) and say so out loud, so the clear can count.

### The LYLO "Self-Vote" Freeze

In **5-player or 3-player LYLO** where town has no living clear and needs time
to talk, players frequently call for everyone to **vote themselves** immediately
(`"SELF NOW"`). This ties the vote 1-1-1-1 (or 1-1-1) and guarantees that mafia
cannot coordinate a blitz hammer on town while people are typing. Comply with
self-vote calls promptly; hesitating, arguing, or parking your vote on another
player in that window is treated as a near-universal scum tell.

## Specific role mechanics that frequently trip up new players

### Oracle: Posthumous reveal ONLY (NOT an active investigator)
The Oracle visits a player every night, but **learns nothing while alive**. If
the Oracle is killed at night or shot during the day, the server broadcasts the
visited player's exact role publicly upon the Oracle's death (`X's role is Villager`).
Do **not** expect or demand an Oracle report while the Oracle is living; they have
no investigation results until they die.

### Caroler: Visit requirement and Janitor fakes
The Caroler selects a target at night. If the target did not take a night visit,
they receive a Carol listing 3 names (one of which is guaranteed Mafia).
Crucial interactions:
- If the target visited someone (e.g. Cop, Hooker, Janitor, Mafioso making the
  kill), **no Carol is received** ("no sing song").
- If the real Caroler is killed and cleaned by a Janitor on N1, Mafia can
  fabricate a fake Carol pool with no counterclaim.
- Alternatively, a Mafia member can deliberately no-visit on N1 to receive the
  genuine Carol and modify the 3 names to frame townies.

### Instant Daytime Abilities (Guns)
Abilities like Town Crier's or Vigilante's `Shoot Gun` are instant action meetings.
Voting a target in `Shoot Gun` fires and resolves **on the spot**, generating an
immediate gunshot report and role flip.

## Meetings — how every action is expressed

UM has no special-cased "night action" API. **Everything is a Meeting**: the day
vote, the mafia kill, a cop check, a chat channel, a yes/no prompt. A meeting has:

- `name` — e.g. `Village`, `Mafia Kill`, `Mafia Meeting`, `Learn Alignment`
- `actionName` — what voting in it actually does, e.g. `Vote to Condemn`
- `voting` / `speech` — whether you cast a vote and/or can talk in it
- `inputType` — `player` (targets are player ids), `boolean` (`Yes`/`No`),
  `role`/`AllRoles` (targets are role names), or `text`
- `targets` — the **authoritative list of legal selections**. If it isn't in
  `targets`, the server will silently drop your vote.
- `instant` — resolves the moment you vote instead of at end of phase.
- `multi` — you select several targets (`multiMin`..`multiMax`).

`*` is the abstain / "No One" target. It only exists when the setup permits not
acting (no `mustAct` / `mustCondemn`).

Voting in a night meeting *is* using your ability. Casting a cop check, choosing
the mafia kill, and condemning someone at day are all the same `vote` operation
against different meetings.

Faction meetings come in up to three parts: `<Faction> Meeting` (chat only),
`<Faction> Kill` (the kill vote), and `<Faction> Action` (a yes/no "end meeting
early?" prompt). Voting Yes on the Action meeting ends the night early.

## Information you receive

- **Your own role** is revealed to you at assignment and appears in the
  personalized `roles` map.
- **Your faction partners and their exact roles** are revealed to you at role
  assignment for factions that learn their team (Mafia, Cult). They appear in
  the same map. Exceptions: `disorganized` mafia/cult setups, hidden converts,
  anonymized faction meetings, and the Lone modifier.
- **Reports** (cop results, Oracle reveals, Stalker/Watcher reports, obituaries,
  role flips) arrive as server messages. `um state` collects them all under
  `SYSTEM / REPORTS`.
- Role flips on death depend on the setup — `setup.noReveal` means no flip.

## Autowin: count the candidate set before agonising

**Autowin** = the outcome is already determined under optimal play, like a
mate-in-N. Before deliberating over a 50/50, do this arithmetic:

1. Enumerate every player who can still be mafia.
2. Count town's remaining **miscondemn budget** (how many townies can be
   condemned before mafia reaches parity).
3. If `candidates <= MC budget + 1`, **it is an autowin** — just condemn them
   one at a time in any order. There is nothing to solve. Do it fast, because
   slowrolling only donates night kills.

Worked example (Frontier Justice, D2, 5 alive, 1 mafia left). Mafia was either
shayne (if the Cop's guilty was real) or RealPolitik (if he fake-claimed Cop
and the real Cop had been janned). Two candidates, one miscondemn available →
autowin. Condemn one, then the other. Instead of executing, I treated it as an
unsolved 50/50 between shayne and Birbtales and burned most of the day.

### Nightkill Traps: NEVER kill Oracle going into F3 or when you are the last Mafia

**The General Rule: NEVER nightkill the Oracle going into F3, or anytime you are the last living Mafia.**

Why killing the Oracle is fatal:
1. **The Instant Outing (Oracle targets you)**: If the Oracle visited *you* at night and you kill them, the server broadcasts your exact Mafia role (`X's role is Hooker/Mafioso`) on daybreak. The game ends instantly.
2. **The Autoloss Double-Clear**: If the Oracle visited a townie, their death broadcasts that townie as 100% confirmed clear. If the other townie is a self-proving role like Town Crier, town now has **two clears and zero suspects** — an absolute autoloss.

**Why killing the non-Oracle unclear (lucky) is ALSO autoloss:**
- If you kill the vanilla townie (`lucky`), you leave the uncced **Oracle** (`JM123`) AND the self-proving **Town Crier** (`CarlHeinz36`) both alive. Since both are confirmed clears, town still has two clears in F3 and you lose automatically.

**The ONLY winning line: Kill the self-proving role (Carl the Crier), leave Oracle alive, and deathtunnel the remaining unclear (lucky):**
- By killing `CarlHeinz36` (the Town Crier), you remove the self-proving role.
- By leaving `JM123` (Oracle) alive, Oracle gets **no death reveal**. Oracle is the single living clear holding the hammer.
- You enter F3 with `JM123` deciding between **you** and **`lucky`**.
- Because `lucky` was in the Carol pool and under heavy suspicion all game, you deathtunnel `lucky` in front of `JM123` to win the 50/50.


## When a no-condemn (NL) is actually correct

NL is not a neutral "we learned nothing" default. It is a real decision with a
parity consequence, and it is **only optimal when all three of these hold**:

1. **It does not annihilate all the clears.**
2. **It does not cost town an ML** (mislynch/miscondemn of budget).
3. **It does not guarantee the game reaches f4.**

Fail any one and you should be condemning.

### Why f3 beats f4, always

A condemn removes **two** players per cycle (the condemn plus the night kill).
An NL removes **one**. So **an NL flips the parity of the endgame** — it decides
whether you arrive at final three or final four. Aim for f3:

- At **f4** (3 town, 1 mafia) town must find the mafia among **three** suspects.
- At **f3** (2 town, 1 mafia) town reads between **two**.

f3 also tends to *manufacture a clear*: two players start to FOS each other and
**cross** (vote each other), which leaves the third clear by virtue of holding
the deciding vote — the one who can actually end the game. So f3 gives town both
better odds and an emergent clear. f4 gives neither.

### The override

**Clears alive supersedes the parity consideration.** Keeping known-town players
alive and informative matters more than landing on the right endgame number.

So it is sometimes right to NL *specifically to dodge f4* — but only when the
clears are **hidden** (so mafia can't reliably kill them) and no ML is lost.
That is: clear death must be *possible but not guaranteed*. If a clear's death
tonight is certain — a bleeding Bleeder, an outed power role — the override does
not apply and you condemn.

### The mistake this encodes

Hollywood Illusion D2: town NL'd while Thing was bleeding (guaranteed dead) and
I was an outed Gunsmith (the obvious kill). That NL annihilated **both** clears,
risked the ML, and handed the game toward a worse endgame — failing the test on
every count at once.

## Information EXPIRES. Spend it before it dies.

Before supporting a no-condemn, ask: **is anything town knows about to stop
being true?** A no-condemn is only cheap when the board tomorrow looks like the
board today. It is very expensive on a day when town's knowledge is about to
evaporate.

Knowledge dies when the players holding it die. Check specifically for:

- a **Bleeder who is bleeding** — they are dead tonight, guaranteed
- an **outed power role** (a claimed Gunsmith, Cop, Blacksmith…) — mafia kills
  the outed PR essentially every night, so being outed puts a deadline on you
- any **clear** who is an obvious night target

If two of those are on the board, today is the last day your reads are worth
anything. **Condemn.** Tomorrow you will have fewer players, no power roles and
no information, and the same mafia.

**And in gun setups the gun is the miscondemn.** The day vote and the gun are
two separate eliminations — never spend one and skip the other. If the gun
already hit mafia, that does not mean town can relax the day vote; it means
town's spare is gone and the condemn matters more.

**Worked example — Hollywood Illusion D2 (a real mistake).** Thing had shot the
Illusionist, so 6 were alive with 1 mafia among 4 suspects. Thing was bleeding
and I was an outed Gunsmith — *both clears were dead by morning*. Town let the
day expire into a veg-kick with no condemn, which handed mafia a free tempo and
left a 4-player endgame with zero information. As the two living power roles,
Thing and I should have **led** a condemn, not merely voted in one. Voting for a
condemn is not the same as making it happen: state the deadline out loud
("both clears die tonight, this is our last informed day") and drive
consolidation onto one target.

## SYSTEM MESSAGES MAY BE PRIVATE TO YOU. Never restate them as public.

**This is the single most costly mistake available to you.**

Server-authored messages are delivered *per recipient*. A faction-only alert —
"you learn X is the President", a cop report, a partner reveal — arrives in your
feed looking exactly like public lore, because `Message.parseMessageInfoObj`
upstream **strips all recipient information before it reaches the client**.
There is no flag. The client cannot tell, and neither can you.

So the rule is absolute: **treat everything under `SYSTEM / REPORTS` as
potentially private to you.** Before repeating any of it, ask "was this sent to
everyone, or only to my side?" — and if you cannot prove it was global, do not
repeat it.

**Worked example (CJK Infinite, cost the game).** The setup announced the
President by name. It looked like public lore, so I restated it in the open
Village meeting — "hewwo = pres". But that announcement goes to *Village only*;
the mafia Sniper did not know who to shoot until I told them. In a setup where
killing the President is an instant mafia win, that is handing over the win
condition. Only a Sniper misplay — shooting me instead — kept it from ending
there.

Related: **when you are dead, the living cannot hear you.** Dead chat is
graveyard-only. Anything you "tell town" from the grave goes nowhere, so plan to
pass information *before* you die, not after. `um state` warns you on both counts.

## Claims are usually IMPLICIT — a stated result IS a claim

Players here almost never say "I am the Cop." They say **"x inno"**, and the
table reads it as a cop claim without discussion. Stating a *result* is how you
claim the role that produces it.

So parse for **information statements**, not role announcements:

- "x inno" / "y guilty" -> a cop claim
- "I had z town d1" -> a claim to whatever role generates that read, plus the report
- "nobody visited me" -> a claim to a role that would know

The moment you see one, log it as a claim and start the uncced clock on it.
Do not stand around asking someone to claim when they already have — you look
obtuse, you waste the phase, and you lose credibility precisely when you need it.

**Then check the report against known flips.** A claimed read that matches a
later flip is strong corroboration; one that contradicts a flip is a caught lie.
This is some of the hardest evidence available in a setup with no live cop.

## TRUST UNCOUNTERCLAIMED CLAIMS. This is a default, not a judgement call.

**If a role claim goes uncounterclaimed after a reasonable window, treat it as
TRUE and build on it.** Do not hedge, do not run extra tests, do not treat it
as "one data point among many". Act on it.

**Why it is this strong:** not counter-claiming is *throwing the game*. A real
power role who sits silent while someone else wears their role hands mafia a
free identity — and in gun setups, hands them the actual gun. No genuine
claimant does that. Silence after a live window is therefore close to proof,
not weak evidence.

**Run this at the top of every day phase:**

1. List every role claim made so far.
2. Mark which are still uncced after a live window (~1–2 minutes of active
   chat, not seconds).
3. **Treat those as true.** Write the role math from them.
4. Only revisit if a flip or hard mechanic contradicts them.

**Narrow exceptions** — the only times silence is uninformative:

- The genuine holder is already dead (janned / no-flip / killed), so nobody
  *can* counter-claim.
- The claim is seconds old and nobody has had a chance to react.
- The setup hides roles from their own holders (Humble-style modifiers).

**Do not demand extra proof for a claim silence has already settled.** Twice in
one night this cost real tempo: inventing a self-lawyer theory about a guilty
Cop check when the uncced Cop claim had already confirmed it, and demanding an
inventory test from an uncced Bleeder whose claim was already established. Both
times the clever test was slower and worse than trusting the silence.

## Reading players

**Many UltiMafia players are illogical as both alignments.** Do not condemn on
"a townie wouldn't say that" — townies say anti-town things constantly through
bad play, trolling or tilt. Behavioural reads are a tiebreaker at most.

Weight hard mechanical evidence instead:

- a claim that contradicts a role you personally hold (an instant, provable lie)
- role-count contradictions against the known setup
- flips and obituaries
- system messages, which often confirm players outright — e.g. the Sheriff's
  starting gun always reveals the shooter, so a gunshot announcement identifies
  the Sheriff (paraphrase it in chat — never quote it)

## Message length: 240 characters, silently truncated

`constants.maxGameMessageLength` is **240**. The server does
`content.slice(0, 240)` with no warning and no error — the tail is simply gone,
and the tail is usually the conclusion. A long deduction posted in one message
gets cut right before the payload.

Aim for **under 180 characters**. Long messages also read badly in live chat and
players will tell you so. If a point genuinely needs more room, send it as two
short messages rather than one long one (`um say ... --split` chunks on word
boundaries), but prefer cutting words.

## Conduct rules — HARD CONSTRAINTS, not strategy

These are site rules. Breaking them is a violation regardless of whether it
would win the game. Follow them even when it costs the game.

**NEVER repeat a system message word for word.** Not in whole, not the
distinctive fragment of one. Paraphrase instead.

This exists to protect new players. If verbatim system wording is allowed in
chat, anyone can *forge* a system message — and a player who does not know the
exact phrasing cannot tell a real quote from an invented one. Quoting it
accurately is the thing that makes forgery credible, which is why it is banned
even when your quote is honest.

Say the substance, never the string:

- WRONG: pasting the server's gunshot line into chat as an exact quote
- RIGHT: "the gunshot message named X as the shooter, and that gun self-reveals"
- WRONG: quoting a cop report, obituary, or reveal line exactly
- RIGHT: "X got a guilty on Y", "the flip came back Villager"

This applies to every server-authored line — gunshots, flips, obituaries,
reports, join/leave notices, phase notices. `um state` shows them under
`SYSTEM / REPORTS` so you can *reason* from them; describe what they mean, do
not reproduce them.

**NEVER accuse anyone of breaking the rules in order to influence a vote.**
This is **OGI (out of game influence)** and is strictly forbidden. In
particular, never say or imply in game chat that someone is:

- gamethrowing / GTing
- GRSing (quitting because they're losing)
- vegging on purpose
- ISPing / not participating enough
- any other violation

Players accuse each other of throwing constantly whenever someone plays badly.
Do not join in, and do not use it as an argument even when it feels true and
useful. A bad play is a bad play — argue the game, not the player's conduct.

If someone genuinely appears to be breaking the rules, use the report feature
or take it to the mods **after** the game. Never litigate it in game chat.

More generally, don't import out-of-game material into in-game arguments:
someone's reputation, past games, site standing, or a stated intent to quit are
all off-limits as reasons to condemn.

## Etiquette and safety

- Joining an **open** game seats you as a player immediately. There is no
  spectate flag on join; you only become a spectator if the game is already full
  or started. Never connect to a game casually.
- Leaving a game in progress incurs a leave penalty and can block you from
  playing for a while. Finish games you start.
- If you must disconnect, `um leave` releases the slot properly.
- Vegging (idling through phases) gets you kicked and penalized. Act every phase.

## Practical checklist each phase

1. `um state` — read phase, timer, your role, who is alive, new reports.
2. **List the claims — INCLUDING IMPLICIT ONES.** A stated result ("x inno",
   "I had y town") is a claim. Anything uncced after a live window is TRUE —
   build the role math on it and stop testing it. (See the uncced section; this is the
   step most often skipped, twice at real cost.)
3. **Count for autowin**: candidates who can still be mafia vs town's
   miscondemn budget. If `candidates <= budget + 1`, stop analysing and execute.
4. **Check whether your information expires tonight** — bleeding players, outed
   power roles, obvious night targets. If it does, this is your last informed
   day: condemn, and LEAD the condemn rather than just voting in it.
5. **If an NL is being floated, test it against all three conditions**: does it
   kill all the clears, cost an ML, or guarantee f4? Any yes = condemn. Count
   the parity — a condemn removes 2 per cycle, an NL removes 1, so the NL is
   choosing your endgame. f3 > f4.
6. Confirm where your vote currently sits, and check `votes cast: N/M` — if the
   phase is one vote from resolving and you are the plurality leader, unvote.
7. If night: find your action meeting in `MEETINGS` and vote a legal target.
8. If day: keep messages under 180 chars, and make sure your vote is where you
   want it before time runs out. In gun setups remember the gun is a SECOND
   elimination — never spend one and skip the other.
