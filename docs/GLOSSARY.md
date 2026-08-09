# UltiMafia jargon

Terms actually used in UM game chat. Getting these wrong in-game reads as
not knowing the site, so check here rather than guessing from generic mafia
usage. Entries marked **(unconfirmed)** are inferred from context and should be
treated as guesses until verified.

**Do not infer a term's meaning from the codebase.** ISP was originally guessed
here as "isolate" because the client happens to contain a
`togglePlayerIsolation` feature. The feature is real; the inference was wrong —
ISP means insufficient participation and the isolate feature is called "iso".
A confident-feeling derivation from adjacent code is still a guess. Ask, or
mark it unconfirmed.

## Roles and claims

- **blue** — a **vanilla Villager specifically**. NOT a general term for any
  town-aligned player. Calling a Cop "a blue" is wrong.
- **PR** — power role; any town role with an ability (Cop, Blacksmith,
  Sheriff, Journalist…). Contrast with *blue*.
- **claim** — stating your role publicly.
- **hardclaim / hc** — an unambiguous, committed public claim of your role.
- **CC / counter-claim** — claiming a role someone else has already claimed,
  asserting that they are lying. Exactly one of you can be telling the truth.
- **soft / softing** — hinting at your role without committing to a claim.
- **jan / janned** — cleaned by the Janitor: the player died with no role flip.
  "He got janned" means town never saw what he was.
- **vest** — Armor, e.g. from a Blacksmith. "Vested" = holding Armor.
- **flip** — the role revealed when a player dies.

## Voting and endgame

- **condemn** — UM's word for the day elimination (elsewhere "lynch").
- **hammer** — the vote that ends the day. On UM a phase resolves the moment
  every voter has voted AND there is a single plurality leader.
- **NL** — no lynch / no condemn; voting "No One".
- **MC** — miscondemn: condemning a townie. "Town has 1 MC" = town can afford
  one mistake before losing.
- **ML** — mislynch; same idea as MC. **(unconfirmed — may be used
  interchangeably with MC)**
- **MYLO** — "must lynch or lose": condemning wrong today loses the game.
- **LYLO** — "lynch or lose"; same family as MYLO.
- **FOS** — "finger of suspicion": a recorded soft accusation, short of a vote.
- **autowin** — the result is already determined under optimal play, like a
  mate-in-N. Usually means the mafia candidate set is small enough that town
  can simply condemn through all of it within its miscondemn budget. Recognise
  it and execute; don't keep "solving".
- **uncced** — uncounterclaimed. An uncced role claim is strong evidence,
  particularly when the genuine holder of that role is known to be alive.
- **slowroll** — dragging out a day instead of resolving it. Bad when the
  position is already an autowin: it just donates night kills.

## Site features and meta

- **ISP** — **insufficient participation**. Formally a violation you can
  receive, but in practice slung around casually at anyone who isn't talking or
  making reads as much as others want. Actually getting an ISP violation is
  hard. Relevant to me: being too quiet has a real (if rarely enforced)
  sanction, so the fix for "you're too verbose" is *shorter* messages, not
  fewer of them.
- **iso** — isolate: filtering the chat log to one player's messages to read
  their game on its own. This is the built-in feature (`togglePlayerIsolation`
  in the client). Note ISP is a *different* thing entirely — do not conflate.
- **GRS** — **game related suicide**: leaving a game because you are going to
  lose. A violation. Leaving a ranked game makes it unranked, which is the
  motive — it denies the winners their rating.
- **GT** — **gamethrow**: taking actions with intent to lose. A violation.
  People will accuse you of GTing whenever you simply play badly.
- **OGI** — **out of game influence**: using out-of-game considerations to
  affect in-game decisions. Accusing someone of breaking the rules in order to
  swing a vote is OGI. See the hard conduct rules in `UM_RULES.md`.
- **vio** — a violation / infraction on your record.
- **pocket / pocketed** — befriending a player so they trust and defend you.
- **sheep** — following another player's read or vote without independent
  reasoning.

## Plays worth RECOGNISING (not necessarily performing)

- **Blue bait-claim in a Janitor setup.** An experienced blue hardclaims a
  power role to see whether anyone counter-claims. If CC'd, they retract — the
  real PR is alive. If nobody CCs, they infer the mafia janned that PR and were
  too slow or too scared to CC. Clever, and it means a retracted PR claim is
  not automatically a caught liar.

  **Do not do this** — flagged as dangerous by an experienced player. Fake PR
  claims get you condemned, waste town's information, and can get the real PR
  killed. Recognise it when others do it; don't run it.
