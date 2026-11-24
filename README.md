# Breakout Rider — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/upinhuy/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/upinhuy/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A momentum trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun/r/hv9zk8y5). It trades 10 SOL of paper money on a replay of recorded Solana pump.fun bonding-curve activity. Nothing is traded for real.

## How it works

On pump.fun, a curve's first seconds decide most of its life. Launch Sniper buys at the launch itself, before any run, with tiny stakes spread over hundreds of coins:

- the creator bought 1.0–2.5 SOL of their own launch (real skin in the game, but not a one-wallet show);
- at most 3 other wallets have bought so far (a launch bundled by many wallets is a dump in waiting);
- the creator has not sold; real SOL reserves between 0.3 and 30 SOL.

Every position exits fast: a 25% take-profit, an 8% stop loss, a trailing stop once up 10%, a 20-slot time limit, or an immediate exit when the creator sells. A light probe mechanism keeps the run above the guardrail minimum of 20 distinct coins if launches ever dry up.

See [STRATEGY.md](STRATEGY.md) for the full rules and parameters.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts` (Node strips types, no build, no install).
- `strategy.ts` — the strategy (Breakout Rider).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 wire shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
