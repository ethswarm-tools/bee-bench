## What

<!-- One paragraph: what does this change? -->

## Why

<!-- What gap or finding motivates it? Reference FINDINGS.md F-numbers if applicable. -->

## How verified

- [ ] Ran `./scripts/run-all.sh` against a local Bee node on Sepolia
- [ ] Aggregated reports regenerated (`results/report.md`, `results/report.html`, `results/report.csv`)
- [ ] All three runners emit the case (or skip with `skip_reason`)
- [ ] CPU-only subset still passes if no Bee node was available

## Affects

- [ ] `bench-spec.json` (case set / params / iters)
- [ ] `runner-go/`
- [ ] `runner-rs/`
- [ ] `runner-js/`
- [ ] `scripts/aggregate.mjs` or related
- [ ] Docs only (README / FINDINGS / INDEX)

## Notes

<!-- Anything reviewer should look at. Variance flags? New skips? Spec hash change? -->
