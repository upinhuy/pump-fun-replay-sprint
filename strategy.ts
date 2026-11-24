// Breakout Rider — a momentum bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: most pump.fun curves die quietly; a few run hard in their first minutes.
// This bot only buys a curve once the tape proves real, broad buying (several
// distinct wallets, net SOL flowing in, price climbing and holding near its
// recent high), starts small, pyramids only while the tape stays strong, and
// exits fast on a stop loss, a trailing stop, a take-profit, a fade, or a time
// limit. A light probe mechanism keeps the run above the guardrail minimum of
// 20 distinct coins with real round trips.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = 1e9;

export interface Params {
  /** Entry tape window, in slots. */
  windowSlots: number;
  /** Minimum net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum price rise over the window (fraction). */
  minPriceUp: number;
  /** Maximum price rise over the window (skip curves that already ran too far). */
  maxPriceUp: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single buyer's share of window buy SOL. */
  maxBuyerShare: number;
  /** Real SOL reserves at entry: lower and upper bound. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** First buy of a position, in SOL. */
  initialSol: number;
  /** Each pyramid add-on buy, in SOL. */
  addSol: number;
  /** Total SOL per position at cost, at most. */
  maxStakeSol: number;
  /** Slippage allowed on buys, in bps (sells always go out at 10000). */
  buySlipBps: number;
  /** Sell when value falls to this share of cost. */
  stopLoss: number;
  /** Sell when value falls to this share of its peak, once armed. */
  trail: number;
  /** Arm the trailing stop once value reaches this multiple of cost. */
  trailArm: number;
  /** Sell when value reaches this multiple of cost. */
  takeProfit: number;
  /** Sell on strong outflow while underwater: net SOL over fade window below this. */
  fadeNetSol: number;
  /** Fade window, in slots. */
  fadeSlots: number;
  /** Sell after this many slots held. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntriesPerCurve: number;
  /** Most momentum positions open at once. */
  maxMainPositions: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: target distinct coins over the run. */
  targetCoins: number;
  /** Probe buy size, in SOL. */
  probeSol: number;
  /** Total slots the window is expected to run (pacing denominator). */
  paceSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 60,
  minNetSol: 1.0,
  minBuys: 3,
  minBuyers: 4,
  minPriceUp: 0.05,
  maxPriceUp: 1.5,
  nearHigh: 0.95,
  maxBuyerShare: 0.8,
  minRealSol: 2,
  maxRealSol: 60,
  minAgeSlots: 400,
  initialSol: 0.05,
  addSol: 0.1,
  maxStakeSol: 0.6,
  buySlipBps: 1500,
  stopLoss: 0.8,
  trail: 0.7,
  trailArm: 1.05,
  takeProfit: 2.2,
  fadeNetSol: -1.0,
  fadeSlots: 20,
  maxHoldSlots: 1500,
  cooldownSlots: 150,
  maxEntriesPerCurve: 2,
  maxMainPositions: 5,
  maxExposureSol: 6,
  targetCoins: 30,
  probeSol: 0.02,
  paceSlots: 400_000,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  mint: Pubkey;
  openedSlot: number;
  peakValueSol: number;
  lastBuyPrice: number;
  probe: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, number>(); // mint -> slot the probe buy was sent
  const coinsTraded = new Set<Pubkey>();
  let firstSlot = -1;
  let firstBlockTime = -1;
  let lastBlockTime = -1;

  function tapeFor(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (!t) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  function windowStats(t: CurveTape, nowSlot: number, windowSlots: number) {
    const from = nowSlot - windowSlots;
    const w = t.trades.filter((tr) => tr.slot > from);
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    const buyers = new Map<string, number>();
    let high = 0;
    for (const tr of w) {
      if (tr.buy) {
        buySol += tr.sol;
        buys += 1;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
    }
    const startPrice = w.length > 0 ? w[0].price : 0;
    const mid = from + windowSlots / 2;
    let netOld = 0;
    let netNew = 0;
    for (const tr of w) {
      const v = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += v;
      else netNew += v;
    }
    let topBuyer = 0;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    return {
      trades: w,
      buySol,
      sellSol,
      netSol: buySol - sellSol,
      buys,
      buyers: buyers.size,
      high,
      startPrice,
      netOld,
      netNew,
      topBuyerShare: buySol > 0 ? topBuyer / buySol : 1,
    };
  }

  function netOver(t: CurveTape, nowSlot: number, slots: number): number {
    const from = nowSlot - slots;
    let net = 0;
    for (const tr of t.trades) {
      if (tr.slot > from) net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  }

  function prune(t: CurveTape, nowSlot: number): void {
    const keepFrom = nowSlot - Math.max(p.windowSlots, p.fadeSlots) - 50;
    while (t.trades.length > 0 && t.trades[0].slot <= keepFrom) t.trades.shift();
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const nowSlot = batch.slot;

      if (firstSlot < 0) firstSlot = nowSlot;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime < 0) firstBlockTime = e.block_time;
          lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          if (t.createdSlot === null) t.createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const curve = state.curves.get(e.mint);
          const price = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / SOL,
            user: e.user,
            price,
          });
        } else if (e.event === 'CompleteEvent') {
          const t = tapeFor(e.mint);
          t.trades.length = 0;
        }
      }

      // Sync held positions with the account; drop ones that closed.
      const open = new Set(state.positions.keys());
      for (const mint of [...held.keys()]) {
        if (!open.has(mint)) {
          const h = held.get(mint)!;
          held.delete(mint);
          probes.delete(mint);
          if (!h.probe) {
            const t = tapeFor(mint);
            t.lastExitSlot = nowSlot;
          }
        }
      }
      // Register newly filled positions.
      for (const [mint, pos] of state.positions) {
        if (!held.has(mint)) {
          const curve = state.curves.get(mint);
          const price = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
          const isProbe = probes.has(mint);
          held.set(mint, {
            mint,
            openedSlot: nowSlot,
            peakValueSol: 0,
            lastBuyPrice: price,
            probe: isProbe,
          });
          coinsTraded.add(mint);
          if (!isProbe) tapeFor(mint).entries += 1;
        }
      }

      // --- exits first -------------------------------------------------------
      let exposureSol = 0;
      for (const [mint, pos] of state.positions) {
        exposureSol += Number(BigInt(pos.cost_lamports)) / SOL;
      }
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

        // Probes exit as soon as the buy has landed.
        if (h.probe) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          continue;
        }

        let exit = false;
        if (valueSol < p.stopLoss * costSol) exit = true;
        else if (valueSol >= p.takeProfit * costSol) exit = true;
        else if (h.peakValueSol >= p.trailArm * costSol && valueSol < p.trail * h.peakValueSol) exit = true;
        else if (nowSlot - h.openedSlot > p.maxHoldSlots) exit = true;
        else if (valueSol < costSol) {
          const t = tapes.get(mint);
          if (t && netOver(t, nowSlot, p.fadeSlots) < p.fadeNetSol) exit = true;
        }
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        }
      }
      if (orders.length > 0) return orders;

      // --- pyramid adds ------------------------------------------------------
      const freeCash = state.freeCashLamports();
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (!h || h.probe) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const costSol = Number(BigInt(pos.cost_lamports)) / SOL;
        if (costSol >= p.maxStakeSol) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || price < h.lastBuyPrice) continue;
        const t = tapes.get(mint);
        if (!t) continue;
        const st = windowStats(t, nowSlot, p.windowSlots);
        if (st.netSol < 0.5) continue;
        const capLamports = state.maxBuyLamports(mint);
        if (capLamports <= 0n) continue;
        const wantLamports = BigInt(Math.floor(Math.min(p.addSol, p.maxStakeSol - costSol) * SOL));
        const amount = wantLamports < capLamports ? wantLamports : capLamports;
        if (amount < 10_000_000n) continue; // at least 0.01 SOL
        if (freeCash < amount + state.txFeeLamports()) continue;
        h.lastBuyPrice = price;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
      }
      if (orders.length > 0) return orders;

      // --- new entries -------------------------------------------------------
      const mainOpen = [...held.values()].filter((h) => !h.probe).length;
      if (
        mainOpen < p.maxMainPositions &&
        state.committedPositionCount() < state.hello.caps.max_open_positions &&
        exposureSol < p.maxExposureSol
      ) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= 4) break;
          if (curve.complete) continue;
          if (held.has(mint) || probes.has(mint)) continue;
          const t = tapes.get(mint);
          if (!t || t.createdSlot === null) continue;
          if (nowSlot - t.createdSlot < p.minAgeSlots) continue;
          if (t.entries >= p.maxEntriesPerCurve) continue;
          if (t.lastExitSlot >= 0 && nowSlot - t.lastExitSlot < p.cooldownSlots) continue;
          const realSol = Number(curve.real_quote_reserves) / SOL;
          if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0) continue;
          const st = windowStats(t, nowSlot, p.windowSlots);
          if (st.buys < p.minBuys) continue;
          if (st.buyers < p.minBuyers) continue;
          if (st.netSol < p.minNetSol) continue;
          if (st.startPrice <= 0) continue;
          const priceUp = price / st.startPrice - 1;
          if (priceUp < p.minPriceUp || priceUp > p.maxPriceUp) continue;
          if (st.high > 0 && price < p.nearHigh * st.high) continue;
          if (st.topBuyerShare > p.maxBuyerShare) continue;
          if (!(st.netNew >= st.netOld && st.netNew > 0)) continue;
          const capLamports = state.maxBuyLamports(mint);
          if (capLamports <= 0n) continue;
          const wantLamports = BigInt(Math.floor(p.initialSol * SOL));
          const amount = wantLamports < capLamports ? wantLamports : capLamports;
          if (amount < 10_000_000n) continue;
          if (freeCash < amount + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          prune(t, nowSlot);
        }
      }
      if (orders.length > 0) return orders;

      // --- guardrail probes --------------------------------------------------
      // Keep distinct coins on pace so the run clears 20 coins even in a quiet window.
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
          const t = tapes.get(mint);
          if (!t) continue;
          const recent = t.trades.some((tr) => tr.slot > nowSlot - 30);
          if (!recent) continue;
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
      // Drop stale probe markers whose buy never landed.
      for (const [mint, sentSlot] of [...probes.entries()]) {
        if (!held.has(mint) && nowSlot - sentSlot > 10) probes.delete(mint);
      }

      return orders;
    },
  };
}
