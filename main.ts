// Breakout Rider — a momentum bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2) on make.fun.
//
// Entry: https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122
// The grader runs `node /bot/main.ts`; Node strips the types, no build step,
// no install, no network. The strategy lives in strategy.ts and the wire shim
// is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte under vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));

// Runtime notes (second writing turn — the entrypoint is written in stages):
// - runBot owns stdin/stdout: it reads hello/batch/done lines, keeps BotState
//   current, and writes exactly one reply per batch. Diagnostics go to stderr.
// - The bot is deterministic: no clock, no environment reads, no Math.random.
//   Every decision comes from the batch stream (slots, reserves, fills).
// - Capital is 10 SOL of paper money; at most 5 open positions; no shorts,
//   no leverage; orders decided on slot s fill at slot s + 2.
// - See STRATEGY.md for the entry/exit rules and the guardrail probes.
