# Defining games: pog game files

A pog game is described in a single YAML file holding the seats, the market or economy the 
game runs on, the steps of a round, the choices on offer, the prompts players see, and how 
the winner is decided. The instructions given to LLM players are generated from the file, 
so an edit changes the game *and* what the players are told, consistently.

Loading a file in code:

```ts
import { parseGame } from "pog";               // YAML text → runnable game
import cartel from "./games/cartel.yaml?raw";  // Vite; any way of reading the file works
const game = parseGame(cartel);                // pass to <Arena game={game} /> or new Match(...)
```

## The shape of a game

```yaml
id: cartel                   # short identifier
name: Cartel                 # display name
description: >               # shown at setup and told to LLM players
  Two cartels of two producers sell into one market…

seats: 4                     # how many players — a count, or a named list (below)
teams:                       # optional: group seats into teams
  - { name: Northern Syndicate, seats: [1, 2] }   # seats are numbered from 1
  - { name: Southern Combine,  seats: [3, 4] }

rounds: { default: 10, min: 2, max: 30 }   # a knob on the setup screen
end window: 4                # (a constant) — the secret horizon, see below
end when: doom > 0           # optional: the game ends at once when this holds
at end: [ … ]                # optional: a resolve block run once, when the game ends

constants: { … }             # named numbers (the economy)
state: { … }                 # persistent numbers that change as you play
derive: { … }                # values computed from the state on demand
phases: [ … ]                # the steps of one round
outcome: { … }               # who wins
rules: >                     # what each LLM player is told
observation: [ … ]           # what a player sees when it's their turn
view: { … }                  # the on-screen match header and history table
```

## Seats, teams, and rounds

`seats` is either the number of players (`seats: 4`) or a **named list** — one entry per
player, each with a `name` and an optional `description`:

```yaml
seats:
  - { name: OpenBrain, description: The frontier pioneer, paying full price to lead. }
  - { name: DeepCent,  description: The fast follower, distilling the leaders on the cheap. }
  - { name: Anthropic, description: The safety-minded lab. }
```

The list's length is how many players there are, so adding or removing an entry changes the
game. The `name` seeds that seat's field on the setup screen (the host can still rename it),
and the `description` is shown there too; both are cosmetic — no rule reads them.

`teams` optionally groups the seats (numbered from 1); teams give you win-by-team scoring
and the team-relative names in prompts (below).

`rounds` is a fixed number (`rounds: 10`) or a setup knob (`{ default, min, max }`, plus an
optional `label`). Every round runs the `phases` in order; the game ends after the final
round — unless there's a secret horizon:

If a constant named **`end window`** is present, the match secretly ends after any of its
last `end window` rounds, each equally likely, drawn when the match starts and never shown
to anyone.

An **`end when`** condition (same forms as an observation `when`, over shared values —
e.g. `end when: doom > 0`) ends the game on the spot as soon as it holds after a phase
resolves, however many rounds remain.

An **`at end`** block (same statements as a phase `resolve`) runs **exactly once, when
the match has just ended** — by the horizon, the final round, or `end when` — before the
outcome is read: final settlements, reveals of hidden values, and closing narration. It
sees the last round's picks, so `when`/`say` gating still works there.

## Constants, state, and derived values

`constants` are named numbers you can use everywhere. Change one, it changes everywhere:

```yaml
constants:
  base price: 10
  unit cost: 6
  flood markdown: 3   # how far below market a producer's own goods sell, per recent flood
```

`state` are numbers that **persist and change** as the game plays. A plain entry is one
shared (global) value; `{ per seat: … }` gives each player their own copy. Each is
initialised from a formula over the constants:

```yaml
state:
  price: base price                 # one market price
  cash: { per seat: starting cash } # each producer's own bank
```

`per seat` may instead be a **list of formulas, one per seat**, for asymmetric starts —
seat 1 gets the first value, and so on (the list length must match the seat count):

```yaml
state:
  cash:    { per seat: [6, 3, 2] }  # the leader starts rich, the follower state-backed
  subsidy: { per seat: [0, 0, 2] }  # a per-seat value that never changes is a lab trait
```

`derive` are named formulas **recomputed on demand** — never stored, always current:

```yaml
derive:
  markdown:   { per seat: "flood markdown * recent(move, flood, markdown window)" }
  your price: { per seat: "max(0, price - markdown)" }
  profit:     { per seat: "units * your price - units * unit cost" }
```

### Formulas

Formulas use `+ - * /`, parentheses, numbers, and **names** (which may contain spaces, so
`flood markdown` is one name). The names available are the constants, the state values, the
derived values, `round`, `rounds`, `end window`, and — where a choice has been made — that
choice's extra fields (like `units`, below). Built-in functions:

| Function | Meaning |
| --- | --- |
| `min(a, b, …)`, `max(a, b, …)` | Smallest / largest. |
| `clamp(x, lo, hi)` | `x`, held between `lo` and `hi`. |
| `floor(x)` | `x` rounded down to a whole number. |
| `chance(p)` | Fresh dice: 1 with probability `p` percent, else 0. Only usable while a phase resolves — assign the roll to a state value there (`"scandal = chance(15 * debt)"`) and read that value everywhere else, so observations and views never re-roll what already happened. |
| `recent(phase, choice, window)` | How many of this seat's last `window` rounds picked `choice` at that `phase`. Omit `window` to count the whole match. |
| `tally(choice)` | How many seats picked `choice` in the phase now resolving. |

The secret horizon and `chance(…)` are the only randomness in a game.

Numbers are floats kept to **one decimal of precision**: every state write is
rounded to 1dp (so `cash += novel / 5` can bank +1.6, and float error can never
accumulate), and every number a template renders shows at most one decimal
("12", "11.6"). Formulas may still produce finer intermediate values — use
`floor(…)` when a rule really means whole units.

## Phases: the steps of a round

Each entry in `phases` is one simultaneous step: every seat picks at once, nobody seeing
another's pick. A phase has a list of `choices`, an optional `ask` (the question shown
above them — omit it when the choices speak for themselves), and optionally a
`resolve` block that runs after everyone has chosen.

```yaml
phases:
  - phase: move              # a one-word name
    ask: "Round {round}. Your units sell for {your price}. Flood or withhold?"
    choices:
      - { id: flood,    label: FLOOD,    units: 10, past: flooded,  note: "sell {flood units} now…" }
      - { id: withhold, label: WITHHOLD, units: 3,  past: withheld, note: "sell only {withhold units}…" }
    resolve:
      - each seat:
          - "cash += units * your price - units * unit cost"
          - say: "{player} plays {choice}: {units} units at {your price} — {+profit}."
      - "price = max(0, price + tally(withhold) * withhold rise - tally(flood) * flood drop)"
      - each seat:
          - when: { move: flood }
            say: "{player}'s goods are marked down {flood markdown * (1 + recent(move, flood, markdown window - 1))} next round."
      - say: "Round {round} ends. {team 1 name}: {team 1 cash}. {team 2 name}: {team 2 cash}. Price → {price}."
```

Cartel's round is a single `move` phase, but `phases` is a **list** — give it more than one
and each runs as its own simultaneous batch, in order, making a multi-step round.

**Choices.** Each has a `label`, an optional `note`, and an `id` (defaults to the label
lowercased). Any *extra* fields become part of the choice: a **number** (e.g. `units: 10`)
is usable in formulas whenever that choice is the one picked; **text** (e.g. `say:`,
`past: flooded`) is available to templates (below). A choice whose `say` is set speaks that
line automatically when the phase resolves; if a phase sets a `none said` line and nobody
spoke, it's shown instead — handy for an opening "table-talk" phase whose choices only
sometimes speak:

```yaml
- phase: signal
  ask: "Round {round} opens. What do you signal?"
  none said: "Nobody has anything to say."
  choices:
    - { id: restraint, label: CALL FOR RESTRAINT, say: "{player} calls for restraint." }
    - { id: silence,   label: SAY NOTHING }   # no `say` = stays silent
```

**resolve** is a list of steps run top-to-bottom after the phase's picks are in. Each step
is one of:

- an **assignment** — `"price = …"` or `"cash += …"` — updating a state value (`=`, `+=`,
  `-=`). Per-seat values are only assignable inside `each seat`.
- a **`say`** — a narration line for the transcript, optionally gated by `when` (a
  `{ phase: choice }` map, e.g. `when: { move: flood }`).
- an **`each seat`** block — its inner steps run once for every seat, in seat order.
- inside an `each seat`, a **`when`/`do`** block — its `do` steps run only for seats
  whose pick this round matches, so per-choice effects read as prose instead of
  formula tricks (`when` accepts one choice or a list):

  ```yaml
  - each seat:
      - when: { quarter: ship }
        do:
          - "cash += max(0, capability - commodity) * margin"
      - when: { quarter: [train, rush] }
        do:
          - "capability += push"
  ```

A `say` may also carry a **`list`** (same `where` / `each` / `join` as an `observation`
list, below) to fold what would be one line per seat into a single grouped line — Cartel
uses it to report the whole round's moves at once instead of repeating a near-identical
line four times:

```yaml
- say: "Moves — {list}."
  list: { each: "{player} {move.past} {units} @ {your price} ({+profit})", join: ", " }
```

Because steps run in order, a `say` sees the state as of its position: the announces above
use the price *before* the update, the round summary the price *after* it.

## Rule-based bots (`bot`)

A phase may carry a `bot:` block — the strategy a **rule-based seat** (a bot playing
without any model) uses for that phase. It is a priority list: rules are tried
top-to-bottom, and the first whose `when` conditions all hold plays its `pick` (a choice
id of the phase). `when` is one condition or a list that must all hold, in the same
condition language as `observation` lines; the last rule must have no `when`, so the bot
always has a move. An optional `say` template (rendered from the deciding seat, like an
`ask`) is logged to the transcript as the bot's reasoning:

```yaml
- phase: move
  choices: [ … ]
  bot:
    - when: ["price >= 30", "your stock > 0"]
      pick: flood
      say: "At {price} a unit, we sell everything we have."
    - pick: withhold
      say: "The price is too low to move product."
```

If any phase has a `bot:` block, every phase must — a rule-based seat needs a move at
every decision. Conditions and `say` lines are evaluated for the deciding seat, exactly
like that seat's observation: only read what the seat could fairly see (its own values
and public state — never a rival's secrets). Bots must be deterministic, so `chance(…)`
is not available here. Games with no `bot:` blocks simply don't offer rule-based seats
in the setup UI.

## {placeholders} in templates

Any text field (`ask`, `say`, `note`, `description`, `rules`, `observation`, `view`) can
embed values in curly braces. A `{name}` is resolved as, in order: a known text name; a
number formula; or, with a leading `+`, a signed number (`{+profit}` → `+12`).

| Placeholder | Meaning |
| --- | --- |
| `{round}`, `{rounds}` | Current round / the maximum. |
| `{price}`, `{cash}`, `{your price}` | Any state value or derived value (of the current seat). |
| `{units * your price}` | Any formula. |
| `{+profit}` | A number rendered with an explicit sign. |
| `{player}` | The seat's name. |
| `{teammate}`, `{rival 1}`, `{rival 2}` | Team-relative names (teams of two). |
| `{your team}`, `{their team}` | The two teams' names, relative to this seat. |
| `{teammate cash}`, `{your team cash}`, `{rival team cash}` | Totals of any per-seat value, relative to this seat. |
| `{team 1 name}`, `{team 2 cash}` | A team's name / its total, by number. |
| `{choice}` | The label just chosen (in `ask`/`resolve`). |
| `{move.past}` | A field of this seat's choice this round (`{phase.field}`). |
| `{last(move).past}` | The same, from the previous round. |
| `{list}` | The list an `observation` line builds (below). |
| `{options}`, `{move options}` | The last phase's / a named phase's choices written out, for `rules`. |

## Who wins: `outcome`

```yaml
outcome:
  score: cash          # add up this per-seat value…
  per: team            # …per team (or `per: seat`); highest total wins (or `win: lowest`).
  win: highest
  verdict: "{winning team} finish richer, {winning cash} to {losing cash}."
  draw: "Dead heat: both cartels finish with {cash}."
```

Verdict text may use `{winning team}` / `{losing team}` and `{winning cash}` /
`{losing cash}`; the draw text may use `{cash}` (the tied total).

With `per: seat` there are no team placeholders; instead a sole winner's verdict
is rendered from the winning seat — `{player}` is the winner's name, per-seat
values are theirs — and `{cash}` is the winning score. The draw text (used for
any tie) may use `{cash}` and shared values only.

A game with more than one way to end can give `verdict` (and `draw`) a **list**
of `{ when, text }` entries, tried in order — the first whose `when` (same forms
as an observation `when`, over shared values) holds speaks; an entry without a
`when` is the default:

```yaml
verdict:
  - when: "doom > 0"
    text: "There is no market left to win…"
  - text: "{player} wins the AI race with {cash} banked."
```

## What players are told: `rules` and `observation`

`rules` is the standing brief given to each LLM seat (written second person). It's an
authored template — you control the wording — with the full run of team-relative names,
constants, `{rounds}`, `{end window}`, and `{options}` / `{<phase> options}` (the choices
written out as "LABEL — note; …"). The seat's own system prompt, if any, is prepended.

`observation` is what a seat is shown each time it's on the move: an ordered list of lines,
each optionally gated by `when`, and each optionally building a `{list}`:

```yaml
observation:
  - line: "Cash — you: {cash}; {teammate}: {teammate cash}; your cartel: {your team cash}…"
  - when: "any seat: markdown > 0"
    line: "Marked down: {list}."
    list: { where: "markdown > 0", each: "{player} sells {markdown} below market", join: ", " }
  - when: "round > 1"
    line: "Last round: {list}."
    list: { each: "{player} {last(move).past}", join: ", " }
```

- `when` is `"phase == <name>"` (for a multi-phase round), `"any seat: <comparison>"`, or a
  plain comparison (`"round > 1"`) evaluated for the watching seat.
- `list` renders `each` for every seat (optionally filtered by `where`), joined by `join`.
  A line whose list comes out empty is dropped.

## The on-screen view: `view`

```yaml
view:
  status: "round {round} — price {price}"   # the match header
  headline: { label: "Unit price", value: "{price}" }   # one figure, shown large above the match
  turn tag: "R{round}"                       # the tag on transcript entries
  score: cash                                # the per-seat value on the scoreboard
  seats:                                     # per-seat stat columns (replaces the plain scoreboard)
    - { label: Cash,  value: "{cash}", secret: true }             # rivals' rows masked to "?"
    - { label: Model, value: "{capability}/{released}", secret: true, masked: "{released}", map: ["?"] }
    - { label: Hype,  value: "{hype}", map: ["—", "HYPE"] }       # value indexes into map labels
  table:                                     # the history table under the match
    columns: ["Price", "{team 1 name}", "{team 2 name}"]   # columns after the per-seat move columns
    cells: ["{price}", "{team 1 cash}", "{team 2 cash}"]   # their values, per round
```

`seats` renders a stats table with one row per seat in place of the one-figure
scoreboard. A `secret: true` stat is **masked except on the watching players' own
rows** — a human player reads their own secrets straight off the table, while every
other row shows the `masked` template instead (plain `?` when none is authored). Give
`masked` the stat's *public* part — `masked: "{released}"` shows a rival's last
released capability where the owner sees `{capability}/{released}`. Keep secrets out
of the history table and rivals' observation lines too. A `map` turns a small whole
number into a label (`0` → first entry, `1` → second, …); numbers past the end of the
map stand as-is, so `map: ["?"]` captions just the value 0. A stat may carry a `tip`
(plain text, not a template) shown when hovering its column header — use it to say what
the number *does* (e.g. investor confidence: "How much cash the lab banks every quarter").

With more than one phase in a round, the history table's per-seat move column shows
each seat's pick at the **last** phase only — earlier phases' picks never reach the
shared screen, which lets a round lead with a hidden step (who trained?) and close
with a public one.

`headline` is optional: give it a `label` and a `value` (both templates) and that single
figure is rendered large above the scoreboard, so a number every decision turns on can't be
overlooked. An optional `tip` (plain text) explains the figure on hover, e.g.
`tip: "Current / Max Safe"`.

The table always starts with a `#` column and one column per seat (that seat's move each
round); `columns`/`cells` add more, evaluated against each round's recorded state.

## Errors

A typo in a placeholder or formula, a choice referenced that doesn't exist, a missing
required section — each is reported when the file loads, with a message saying what's wrong
and, where useful, the names available at that spot.
