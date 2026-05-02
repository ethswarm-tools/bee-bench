---
name: New case proposal
about: Propose a new benchmark case (CPU or network)
title: '[case] '
labels: enhancement
---

## Proposed case

- **id:** `<domain>.<sub>.<verb>` — e.g. `net.bzz.download.range`
- **kind:** `cpu` | `net`
- **doc:** <!-- one-line description that will appear under the case heading in the report -->

## Params

<!-- explicit list, OR params_from: sizes_mb / sizes_mb_plus_large -->

```json
{ "params": [{ "size_mb": 1 }, { "size_mb": 10 }] }
```

## Why

<!-- What client behavior or Bee endpoint does this expose that existing cases don't? -->

## Implementation notes

- bee-go: <!-- which client method, any quirks -->
- bee-rs: <!-- ditto; flag if any runner can't implement (skip_reason) -->
- bee-js: <!-- ditto -->

## Expected story in the report

<!-- e.g. "Should land in the Network download group; bee-rs likely fastest because reqwest pools connections" -->
