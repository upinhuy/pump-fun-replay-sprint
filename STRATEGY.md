# Launch Sniper — strategy notes

## Market model

The harness replays recorded pump.fun `TradeEvent` / `CreateEvent` /
`CompleteEvent` logs. The bot starts with 10 SOL of paper money, may hold at
most 5 open positions, and may not short or use leverage. Orders decided on
slot `s` fill at slot `s + 2`. A buy may spend at most 1% of a curve's real
SOL reserves per reply. Fees are ~1.25% of size per trade plus a 105,000
lamport transaction fee per order, and ~2% of transactions fail (fees paid,
nothing traded).

Price of a curve is `virtual_quote_reserves / virtual_token_reserves`.

## Why snipe, not chase momentum

On the dev window, chasing coins that already ran (momentum entries after a
5%+ rise) lost money badly: the pilot momentum bot scored −9.49 SOL with a
96% drawdown, and an earlier momentum version of this bot scored −6.87 SOL.
By the time a pump shows up on the tape, the dump has usually started. The
sniper instead buys at the launch itself, before any run, with tiny stakes
spread over hundreds of coins.

## Entry (all must hold)

- Age 0–6 slots since the `CreateEvent`.
- Creator's own buys in the opening slots between 1.0 and 2.5 SOL: the
  creator has real skin in the game, but not so much that the launch is a
  one-wallet show. (This filter alone moved the dev-window score from
  negative to positive; launches with no creator buy are mostly dead.)
- At most 3 distinct non-creator buyers so far: a launch bundled by many
  wallets is a dump in waiting.
- Creator has not sold.
- Real SOL reserves between 0.3 and 30 SOL.
- Price runup from the create price within 0–100× (a sanity window).
- Stake 0.1 SOL per coin, capped at 1% of real reserves (binding at launch,
  so real buys are ~0.01–0.025 SOL) and at least 0.005 SOL.
- One entry per curve.

## Exits (sell the whole position)

- Take-profit: value ≥ 1.25× cost.
- Stop loss: value ≤ 0.92× cost.
- Trailing stop: once value ≥ 1.10× cost, sell when value < 85% of its peak.
- Time limit: 20 slots held.
- Immediate exit when the creator sells while held.
- A completed curve is closed by the replay itself.

## Guardrail probes

The competition requires a round trip of ≥ 0.01 SOL on at least 20 distinct
coins and a maximum drawdown ≤ 50%. Sniper entries normally cover far more
than 20 coins; if launches ever dry up, a probe mechanism buys 0.02 SOL of
the most liquid recently-traded curve not yet traded and sells it as soon as
the buy lands, keeping distinct coins on pace.

## Dev-window results (local sim, partial window; full-window grade-local)

- Sniper defaults as shipped: net PnL positive on every failed-tx draw
  tested (mean +0.067 SOL on the partial window), max drawdown under 1%,
  ~45 coins on the partial window (~135 expected on the full 24 h window).
- The pilot sniper baseline on the same full dev window scored −0.47 SOL;
  the pilot momentum baseline −9.49 SOL.

## Determinism

No clock, no environment reads, no randomness. Every decision comes from the
batch stream. The two grading executions must produce byte-identical action
logs, so all iteration is over insertion-ordered maps fed by that stream.
