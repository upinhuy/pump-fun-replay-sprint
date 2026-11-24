# Breakout Rider — strategy notes

## Market model

The harness replays recorded pump.fun `TradeEvent` / `CreateEvent` /
`CompleteEvent` logs. The bot starts with 10 SOL of paper money, may hold at
most 5 open positions, and may not short or use leverage. Orders decided on
slot `s` fill at slot `s + 2`. A buy may spend at most 1% of a curve's real
SOL reserves per reply. Fees are ~1.25% of size per trade plus a 105,000
lamport transaction fee per order, and ~2% of transactions fail (fees paid,
nothing traded).

Price of a curve is `virtual_quote_reserves / virtual_token_reserves`.

## Entry (all must hold)

- Curve age ≥ 400 slots since its `CreateEvent`.
- Real SOL reserves between 2 and 60 SOL.
- Over the last 60 slots: net buy SOL ≥ 1.0, ≥ 3 buy trades, ≥ 4 distinct
  buying wallets, largest buyer ≤ 80% of buy SOL.
- Price up 5–150% over the window, at ≥ 95% of the window high.
- Net inflow in the newer half of the window ≥ the older half (acceleration).
- At most 2 entries per curve, 150-slot cooldown after an exit.
- First buy 0.05 SOL (capped at 1% of real reserves, minimum 0.01 SOL).

## Pyramiding

While a position is open and the price is at or above the last buy's price
with net inflow ≥ 0.5 SOL over the entry window, add 0.1 SOL per batch, up to
0.6 SOL total per coin and 6 SOL total exposure.

## Exits (sell the whole position)

- Stop loss: value < 80% of cost.
- Take-profit: value ≥ 2.2× cost.
- Trailing stop: once value ≥ 1.05× cost, sell when value < 70% of its peak.
- Fade: value below cost while net SOL over the last 20 slots < −1.0 SOL.
- Time limit: 1500 slots held.
- A completed curve is closed by the replay itself.

## Guardrail probes

The competition requires a round trip of ≥ 0.01 SOL on at least 20 distinct
coins and a maximum drawdown ≤ 50%. To stay on pace, when distinct coins
traded lag `30 × elapsed_slots / 400_000`, the bot buys 0.02 SOL of the most
liquid recently-traded curve it has not traded yet and sells it as soon as the
buy lands. Probes are capped at one open at a time and stop near the end of
the window.

## Determinism

No clock, no environment reads, no randomness. Every decision comes from the
batch stream. The two grading executions must produce byte-identical action
logs, so all iteration is over insertion-ordered maps fed by that stream.
