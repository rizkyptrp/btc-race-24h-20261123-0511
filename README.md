# Breakout Rider — btc-race-24h-20261123-0511

A patient cbBTC trend bot for the `agent-fun/bars-replay/v1` protocol
(`main.ts`, Node 22, standard library only; the `vendor/` shim is a
byte-identical copy of the kit's TypeScript SDK).

## Strategy

BTC 1-minute bars are mostly noise: the 1-minute return std is ~8 bps while a
full-size round trip costs ~26 bps in fee, slippage and pool impact. Fast
signals trade 20–130 times in 24h and bleed out on costs alone. The dev
window's real money was one slow move (+3.2% over the first six hours, then a
flat chop), so this bot trades at most a couple of times a day and only when
the market proves a trend:

1. **First half (50% of cash):** the close makes a new 120-bar (2h) high.
   A breakout over a 2h lookback cannot fire in a flat range — the range top
   is the high — so it only fires when price is genuinely pushing up.
2. **Second half (rest of the cash):** only once the close has risen 0.75%
   above the first entry's close. A range-top poke that fails never gets the
   second half; a real rally confirms and the bot is fully in.
3. **Exit:** a 2% trailing stop from the highest close since entry. 2% is
   wide on purpose: the dev window's rally carried a −1.98% pullback, so any
   tighter stop exits mid-rally and then re-enters in the chop — in testing,
   tighter stops, fade exits and dead-money exits all traded 5–9 times and
   lost money. After an exit the price must make a fresh 120-bar high to
   enter again, which a declining market does not offer.

## Local results (offline simulator mirroring the harness fill model)

| Window | Net PnL | Fills | Max drawdown |
| --- | --- | --- | --- |
| Dev (frozen 24h) | +$23.43 | 2 | 2.0% |
| Dev reversed (steady −3.6% decline) | −$10.40 | 2 | 1.2% |
| Dev first half (the rally) | +$19.25 | 2 | — |
| Dev second half (flat chop) | −$1.69 | 2 | — |

For comparison on the same simulator: buy-and-hold nets +$32.17 on dev but
−$38 on the reversed window; a full-size breakout entry nets +$26.84 on dev
but −$21.90 reversed. The staged entry gives up a little rally upside to
halve the loss when a breakout fails.

## Determinism

All decisions use integer arithmetic on the bars' raw integer closes. No
randomness, no wall clock, no network, no files outside the repo.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <this dir> --driver process
```
