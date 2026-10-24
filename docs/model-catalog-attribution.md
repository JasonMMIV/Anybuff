# models.dev catalog — source and attribution

AnyBuff bundles a projected snapshot of the public **models.dev** model catalog
to provide default model facts (context windows, output limits, modalities,
tool/structured-output support, reasoning options, lifecycle status and
pricing) for models the user has not declared in `anybuff.json`.

## Source

| Item | Value |
| --- | --- |
| Upstream | [models.dev](https://models.dev) |
| Endpoint | `https://models.dev/api.json` |
| Snapshot artifact | `sdk/src/impl/model-catalog-snapshot.ts` |
| Sync script | `bun run sync:model-catalog` (`scripts/sync-model-catalog.ts`) |
| Runtime cache | `<dataDir>/model-catalog-cache.json` (host-injected, ADR-13 atomic write) |

The snapshot header records the retrieval timestamp
(`MODEL_CATALOG_SNAPSHOT_AT`) and the schema version
(`MODEL_CATALOG_SCHEMA_VERSION`). Re-run the sync script after each quarterly
verification (maintenance guide non-negotiable #5) or when a user reports a
model that models.dev knows but the app does not.

## License

models.dev is **MIT licensed**:

```
MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What is stored, and what is not

**Stored** (projected from `/api.json`, compact positional tuples):

- `limit.context` / `limit.input` / `limit.output`
- `modalities.input` / `modalities.output`
- `tool_call`, `structured_output`, `attachment`
- `reasoning`, `reasoning_options`, `temperature`, `interleaved`
- `canonical_model_id`, `status`, `type` (used only to filter non-chat rows)
- `cost.*` (input/output/reasoning/cache read/cache write/audio, tiered and
  long-context pricing)

**Dropped** (display-only, not needed for behaviour): `name`, `description`,
`family`, `knowledge`, `release_date`, `last_updated`, `open_weights`,
`provider.*`, `experimental.*`, `license`, `links`, `weights`.

**Never sent to models.dev**: no user data, prompts, transcripts, provider
names, base URLs or API keys. The online refresh is a plain unauthenticated
`GET /api.json` and can be disabled with `modelCatalog: { "online": false }`
in `anybuff.json` (advanced config; no UI in P0).

## Size budget

The committed snapshot must stay under **3 MB** (hard cap) with a **2 MB**
target; the current projection is ~1.05 MB for ~8,400 provider-model entries.
`bun scripts/sync-model-catalog.ts --stats` prints coverage and size, and
`sdk/src/impl/__tests__/model-catalog-snapshot.test.ts` fails the build if the
cap is exceeded.
