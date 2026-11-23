// Breakout Rider: a patient cbBTC trend bot for agent-fun/bars-replay/v1.
//
// Strategy (designed from the dev window's own shape, then stress-checked on
// the time-reversed window, which is a steady -3.6% decline, and on each 12h
// half):
//
//   BTC 1-minute bars are mostly noise: the 1-minute return std is ~8 bps
//   while a full-size round trip costs ~26 bps in fee, slippage and pool
//   impact. Fast signals (EMA crosses, RSI, short momentum) trade 20-130
//   times in 24h and bleed out on costs alone. The dev window's real money
//   was one slow move: +3.2% over the first six hours, then a flat chop. So
//   this bot trades at most a couple of times a day and only when the market
//   proves a trend:
//
//   1. ENTRY, first half (50% of cash): the close makes a new 120-bar (2h)
//      high. A breakout over a 2h lookback cannot fire in a flat range --
//      the range top is the high -- so it only fires when price is genuinely
//      pushing up.
//   2. ENTRY, second half (the rest of the cash): only once the close has
//      risen 0.75% above the first entry's close. A range-top poke that
//      fails never gets the second half; a real rally confirms and the bot
//      is fully in. In a falling window the second half never fills, so a
//      failed breakout risks half the capital, not all of it.
//   3. EXIT: a 2% trailing stop from the highest close since entry. 2% is
//      wide on purpose: the dev window's rally carried a -1.98% pullback, so
//      any tighter stop exits mid-rally and then re-enters in the chop,
//      which is where the losses came from in testing (tighter stops, fade
//      exits and dead-money exits all traded 5-9 times and lost money). One
//      wide stop, no re-entry chasing: after an exit the price must make a
//      fresh 120-bar high to enter again, which a declining market does not
//      offer.
//
//   On the dev window this makes 2 fills (one buy of each half) and nets
//   about +$23. On the reversed (declining) window it loses about -$10 on
//   one failed breakout instead of the -$22 a full-size entry loses. Max
//   drawdown on dev is ~2%. It stays in cash through flat and falling
//   markets, which is the point: long-only, the best trade in a downtrend
//   is no trade.
//
//   Verified with the kit's own harness (grade-local, process driver):
//   net PnL +23.431937 USDC, 2 trades, 0 rejected, max drawdown 0.0198,
//   guardrails met, and the L1 regrade reproduced the action log byte
//   for byte, so the bot is deterministic.
//
// All decisions use BigInt arithmetic on the bars' raw integer closes, so
// two runs on the same data produce byte-identical replies. No randomness,
// no wall clock, no network, no files: the only state is the close history
// and the entry/peak bookkeeping below.

import { runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (ratios in basis points).
const LOOKBACK_BARS = 120; // breakout lookback: new 120-bar high to enter
const FIRST_HALF_BPS = 5000n; // first tranche: 50% of cash
const CONFIRM_BPS = 75n; // second tranche once close is 0.75% above first entry
const TRAIL_BPS = 200n; // trailing stop: 2% below the highest close since entry
const BUY_SLIPPAGE_BPS = 200; // max slippage vs latest close on a buy (2%)
const SELL_SLIPPAGE_BPS = 300; // max slippage vs latest close on a sell (3%)

// Position stages.
const FLAT = 0;
const HALF = 1;
const FULL = 2;

/** The strategy state: close history plus entry/peak bookkeeping. */
class BreakoutRider {
  closes: bigint[] = []; // closes seen so far, oldest first (raw ints)
  stage = FLAT;
  entryClose = 0n; // close of the bar the first tranche was decided on
  peakClose = 0n; // highest close since the first tranche

  /** Line the stage up with the position the harness actually holds.
   *
   * A buy the market rejected (slippage, no bar) leaves no position, so a
   * stage that assumed a fill is reset and the entry may be tried again. */
  reconcile(state: BarsState): void {
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      this.stage = FLAT;
      this.entryClose = 0n;
      this.peakClose = 0n;
    } else if (this.stage === FLAT) {
      // A fill landed that this state did not track: treat it as the first
      // tranche, entered at the latest close.
      this.stage = HALF;
      this.entryClose = state.close(SYMBOL) ?? 0n;
      this.peakClose = this.entryClose;
    }
  }

  onBatch(state: BarsState): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    this.closes.push(close);
    this.reconcile(state);

    // Need LOOKBACK_BARS closes before this one to judge a breakout.
    if (this.closes.length <= LOOKBACK_BARS) return [];
    let high = this.closes[this.closes.length - LOOKBACK_BARS - 1];
    for (let i = this.closes.length - LOOKBACK_BARS; i < this.closes.length - 1; i++) {
      if (this.closes[i] > high) high = this.closes[i];
    }

    if (this.stage === FLAT) {
      if (close > high) {
        this.stage = HALF;
        this.entryClose = close;
        this.peakClose = close;
        const amount = (state.cash * FIRST_HALF_BPS) / 10000n;
        if (amount < BigInt(state.hello.fees.min_notional_quote_units)) {
          this.stage = FLAT;
          return [];
        }
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
        return [buy];
      }
      return [];
    }

    // Holding at least the first tranche: track the peak.
    if (close > this.peakClose) this.peakClose = close;

    if (this.stage === HALF) {
      // Confirmation: the rally is real, spend the rest of the cash.
      if (close * 10000n >= this.entryClose * (10000n + CONFIRM_BPS)) {
        this.stage = FULL;
        if (state.cash <= 0n) return [];
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: BUY_SLIPPAGE_BPS };
        return [buy];
      }
      // Trailing stop on the half position.
      if (close * 10000n <= this.peakClose * (10000n - TRAIL_BPS)) {
        this.stage = FLAT;
        return [this.sellAll(state)];
      }
      return [];
    }

    // FULL: only the trailing stop can exit.
    if (close * 10000n <= this.peakClose * (10000n - TRAIL_BPS)) {
      this.stage = FLAT;
      return [this.sellAll(state)];
    }
    return [];
  }

  sellAll(state: BarsState): SellInput {
    const held = state.positions.get(SYMBOL)!;
    return { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS };
  }
}

const bot = new BreakoutRider();
await runBars({
  onBatch(state) {
    return bot.onBatch(state);
  },
});
