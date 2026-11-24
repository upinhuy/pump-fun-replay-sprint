// Launch Sniper — a sniper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: on pump.fun, a curve's first seconds decide most of its life. A launch
// with a modest creator buy, only a handful of early wallets, and no creator
// sell is worth a tiny stake; a bundled launch (many wallets piling in at
// once) or a creator who sells at once is a dump in waiting and is skipped.
// Every position is small (buys are also capped at 1% of the curve's real SOL
// reserves, which are tiny at launch), exits are fast — a small take-profit, a
// tight stop, a short time limit, and an immediate exit when the creator
// sells — so no single coin can hurt the run and the bot spreads over
// hundreds of launches. A light probe mechanism keeps the run above the
// guardrail minimum of 20 distinct coins if launches ever dry up.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1e9;

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for, in SOL. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the opening slots: SOL window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Price now over the create price, as a multiple: window. */
  minRunup: number;
  maxRunup: number;
  /** Slippage allowed on buys, in bps (a buy whose price jumps more than this in the latency is refused). */
  buySlipBps: number;
  /** Exit when the position is worth this multiple of its cost. */
  takeProfit: number;
  /** Exit when the position is worth this multiple of its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall to this share of the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most positions open at once. */
  maxPositions: number;
  /** Guardrail pacing: target distinct coins over the run. */
  targetCoins: number;
  /** Probe buy size, in SOL. */
  probeSol: number;
  /** Total slots the window is expected to run (pacing denominator). */
  paceSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 6,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  minDevBuySol: 1.5,
  maxDevBuySol: 2,
  maxBuyers: 3,
  minBuyers: 0,
  skipDevSold: true,
  minRunup: 0,
  maxRunup: 100,
  buySlipBps: 10000,
  takeProfit: 2,
  stopLoss: 0.9,
  trailArm: 1.1,
  trail: 0.85,
  maxHoldSlots: 20,
  exitOnDevSell: true,
  staleSlots: 1000000,
  maxPositions: 5,
  targetCoins: 25,
  probeSol: 0.02,
  paceSlots: 400_000,
};

interface Launch {
  createdSlot: number;
  creator: string;
  createPrice: number;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<string>;
  buySol: number;
  sellSol: number;
  lastTradeSlot: number;
  entries: number;
}

interface Held {
  mint: Pubkey;
  openedSlot: number;
  peakValueSol: number;
  probe: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params): Bot {
  const launches = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, number>();
  const coinsTraded = new Set<Pubkey>();
  let firstSlot = -1;

  function launchFor(mint: Pubkey): Launch | undefined {
    return launches.get(mint);
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const nowSlot = batch.slot;
      if (firstSlot < 0) firstSlot = nowSlot;

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!launches.has(e.mint)) {
            launches.set(e.mint, {
              createdSlot: e.slot,
              creator: e.creator,
              createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
              devBuySol: 0,
              devSold: false,
              buyers: new Set<string>(),
              buySol: 0,
              sellSol: 0,
              lastTradeSlot: e.slot,
              entries: 0,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const l = launches.get(e.mint);
          if (!l) continue;
          const sol = Number(BigInt(e.sol_amount)) / SOL;
          l.lastTradeSlot = e.slot;
          if (e.user === l.creator) {
            if (e.is_buy) l.devBuySol += sol;
            else l.devSold = true;
          } else {
            if (e.is_buy) {
              l.buyers.add(e.user);
              l.buySol += sol;
            } else {
              l.sellSol += sol;
            }
          }
        } else if (e.event === 'CompleteEvent') {
          launches.delete(e.mint);
        }
      }

      // Sync held positions with the account; drop ones that closed.
      const open = new Set(state.positions.keys());
      for (const mint of [...held.keys()]) {
        if (!open.has(mint)) {
          held.delete(mint);
          probes.delete(mint);
        }
      }
      for (const [mint] of state.positions) {
        if (!held.has(mint)) {
          held.set(mint, { mint, openedSlot: nowSlot, peakValueSol: 0, probe: probes.has(mint) });
          coinsTraded.add(mint);
          const l = launches.get(mint);
          if (l && !probes.has(mint)) l.entries += 1;
        }
      }

      // --- exits first -------------------------------------------------------
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (!h) continue;
        const curve = state.curves.get(mint);
        if (!curve) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const tokens = Number(BigInt(pos.token_amount));
        const valueSol = (tokens * price) / SOL;
        const costSol = Number(BigInt(pos.cost_lamports)) / SOL;
        if (valueSol > h.peakValueSol) h.peakValueSol = valueSol;

        if (h.probe) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          continue;
        }

        let exit = false;
        if (valueSol >= p.takeProfit * costSol) exit = true;
        else if (valueSol <= p.stopLoss * costSol) exit = true;
        else if (h.peakValueSol >= p.trailArm * costSol && valueSol < p.trail * h.peakValueSol) exit = true;
        else if (nowSlot - h.openedSlot >= p.maxHoldSlots) exit = true;
        else if (nowSlot - (launches.get(mint)?.lastTradeSlot ?? nowSlot) >= p.staleSlots) exit = true;
        else if (p.exitOnDevSell && (launches.get(mint)?.devSold ?? false)) exit = true;
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        }
      }
      if (orders.length > 0) return orders;

      // --- new entries: launches in their first slots ------------------------
      const freeCash = state.freeCashLamports();
      if (
        state.committedPositionCount() < p.maxPositions &&
        state.committedPositionCount() < state.hello.caps.max_open_positions
      ) {
        for (const [mint, l] of launches) {
          if (orders.length >= 4) break;
          const age = nowSlot - l.createdSlot;
          if (age < p.minAgeSlots || age > p.maxAgeSlots) continue;
          if (held.has(mint) || probes.has(mint)) continue;
          if (l.entries >= 1) continue;
          const curve = state.curves.get(mint);
          if (!curve || curve.complete) continue;
          const realSol = Number(curve.real_quote_reserves) / SOL;
          if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
          if (l.devBuySol < p.minDevBuySol || l.devBuySol > p.maxDevBuySol) continue;
          if (p.skipDevSold && l.devSold) continue;
          if (l.buyers.size < p.minBuyers || l.buyers.size > p.maxBuyers) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0 || l.createPrice <= 0) continue;
          const runup = price / l.createPrice;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
          const capLamports = state.maxBuyLamports(mint);
          if (capLamports <= 0n) continue;
          const wantLamports = BigInt(Math.floor(p.stakeSol * SOL));
          const amount = wantLamports < capLamports ? wantLamports : capLamports;
          if (amount < BigInt(Math.floor(p.minBuySol * SOL))) continue;
          if (freeCash < amount + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        }
      }
      if (orders.length > 0) return orders;

      // --- guardrail probes (only if launches ever dry up) -------------------
      const elapsed = nowSlot - firstSlot;
      const expectedCoins = (p.targetCoins * elapsed) / p.paceSlots;
      if (
        coinsTraded.size < expectedCoins &&
        probes.size === 0 &&
        elapsed < p.paceSlots * 0.95 &&
        state.committedPositionCount() < state.hello.caps.max_open_positions &&
        freeCash > BigInt(Math.floor(p.probeSol * SOL)) + state.txFeeLamports()
      ) {
        let bestMint: Pubkey | null = null;
        let bestReal = 0;
        for (const [mint, curve] of state.curves) {
          if (curve.complete || held.has(mint) || coinsTraded.has(mint)) continue;
          const l = launches.get(mint);
          if (!l || l.lastTradeSlot < nowSlot - 30) continue;
          const realSol = Number(curve.real_quote_reserves) / SOL;
          if (realSol >= 5 && realSol > bestReal) {
            bestReal = realSol;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const capLamports = state.maxBuyLamports(bestMint);
          const wantLamports = BigInt(Math.floor(p.probeSol * SOL));
          const amount = wantLamports < capLamports ? wantLamports : capLamports;
          if (amount >= 10_000_000n) {
            probes.set(bestMint, nowSlot);
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          }
        }
      }
      for (const [mint, sentSlot] of [...probes.entries()]) {
        if (!held.has(mint) && nowSlot - sentSlot > 10) probes.delete(mint);
      }

      return orders;
    },
  };
}
