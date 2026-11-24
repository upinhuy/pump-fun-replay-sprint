# Breakout Rider — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/upinhuy/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/upinhuy/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A momentum trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun/r/hv9zk8y5). It trades 10 SOL of paper money on a replay of recorded Solana pump.fun bonding-curve activity. Nothing is traded for real.

## How it works

Most pump.fun curves die quietly; a few run hard in their first minutes. Breakout Rider only buys a curve once the tape proves real, broad buying:

- several distinct wallets buying, net SOL flowing in over a 60-slot window;
- price up 5–150% over the window and holding near its window high;
- the newer half of the window accelerating over the older half;
- no single wallet dominating the buys; real SOL reserves between 2 and 60 SOL.

It starts small (0.05 SOL), pyramids only while the tape stays strong (up to 0.6 SOL per coin), and exits fast: a 20% stop loss, a 30% trailing stop once up 5%, a 2.2× take-profit, a fade exit on strong outflow while underwater, or a 1500-slot time limit. A light probe mechanism keeps the run above the guardrail minimum of 20 distinct coins with real round trips.

See [STRATEGY.md](STRATEGY.md) for the full rules and parameters.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts` (Node strips types, no build, no install).
- `strategy.ts` — the strategy (Breakout Rider).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 wire shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
