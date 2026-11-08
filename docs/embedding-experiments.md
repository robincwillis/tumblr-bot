# Experimenting with embedding models & search strategies

Status: **plan**. Nothing here is implemented except the baseline (local CLIP ViT-B/32,
`src/embeddings/clip.js`). The goal is to find out, on *your* photos and *your* kinds of
queries, which model and strategy retrieves best per unit of cost, and to make switching
cheap. Model facts below come from memory of vendor docs, not from running anything: items
marked **(verify)** must be checked against current docs/pricing before you rely on them.

## 1. What we're optimising

The product question is: *"given a description or a reference photo, are the photos I'd
actually want in the top few results?"* Agents look at ~5 results with `view_photo`, so
**top-5/top-10 quality matters far more than deep recall**. Secondary axes:

| Axis | Why it matters here |
|---|---|
| Retrieval quality (nDCG@10, Recall@10, MRR) | the point |
| Index time & cost | one-off for a library of N photos, then incremental |
| Query latency & cost | per search; local is free, APIs add a network hop |
| Privacy | third-party = your photos are uploaded (see §3.4) |
| Storage | vectors × dim × 4 bytes; matters past ~100k photos |
| Ops burden | model download, GPU/CPU, API keys, rate limits |

## 2. Candidates

### 2.1 Local, via `@huggingface/transformers` (ONNX; no key, no upload)

| Model | Notes |
|---|---|
| CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`) | **Current baseline.** Smallest/fastest, 512-d, 224 px input. |
| CLIP ViT-B/16, ViT-L/14 (`Xenova/clip-vit-large-patch14`) | Same code path as baseline (just `embedding.model`). Larger = better and slower; ViT-L is ~4× the compute. |
| SigLIP / SigLIP 2 (Google) | Usually beats OpenAI CLIP at the same size on retrieval; different tokenizer/processor classes (`SiglipModel`) so needs its own adapter. **(verify)** an ONNX export exists for the size you want. |
| OpenCLIP (LAION/DFN/MetaCLIP weights) | Strong, many sizes. ONNX availability for transformers.js varies — may need Python (`open_clip`) behind a tiny local HTTP/stdio shim instead. |
| Jina CLIP v2 | Multilingual text tower, better text-side retrieval than OpenAI CLIP; also offered as an API. **(verify)** licence and transformers.js support. |

### 2.2 Hosted APIs (photos leave your machine)

| Provider | Notes |
|---|---|
| **Voyage multimodal** (`voyage-multimodal-3`, possibly a newer revision **(verify)**) | Text and images in one space, accepts interleaved inputs; has `input_type: "query" \| "document"`. Vendor reports it beating CLIP-family models on mixed text/image retrieval; **treat as a claim to test, not a fact.** Billed per token (images count as tokens) **(verify pricing)**; rate limits apply, so batching + backoff needed. |
| Cohere Embed v4 (multimodal) | **(verify)** image support and dims. |
| Google Vertex `multimodalembedding` | **(verify)** quota and region/data-handling terms. |
| Amazon Titan Multimodal Embeddings | **(verify)**. |

### 2.3 Strategies (orthogonal to the model — can stack on any of the above)

1. **Prompt templating for CLIP-style text queries.** Wrap the query (`"a photo of {q}"`) or
   average several templates. Cheap, often a measurable lift for short queries.
2. **LLM query rewriting.** Claude expands "moody" or "cozy" into concrete visual terms
   before embedding; or generates 3 paraphrases and fuses scores. Costs one LLM call/query.
3. **Hybrid text + vector.** Fuse vector score with a keyword score over path/tags/captions
   (reciprocal rank fusion). Helps when folder names carry real signal ("Japan/2019").
4. **VLM captions as a second index.** Have Claude caption each photo once (also gives alt
   text for free!), embed the captions with a text-embedding model, search both indexes and
   fuse. Index cost is high (one VLM call per photo) but captions are human-inspectable,
   handle text-in-image and counting better than CLIP, and are reusable for posting.
5. **VLM reranking.** Take the top-K (e.g. 20) from the cheap vector search and have Claude
   judge each against the query. Highest precision, highest per-query cost and latency;
   the agent skill effectively already does a manual version of this via `view_photo`.
6. **Input handling.** Higher-resolution thumbnails; center-crop vs pad vs multi-crop/tiling
   for wide panoramas (CLIP's square crop silently drops the edges of a panorama).
7. **Vector tricks.** Matryoshka-style truncation / int8 quantisation to shrink storage —
   only matters at large scale; evaluate quality loss if/when you get there.
8. **Image-to-image (`similarTo`) is its own task.** A model that's best at text→image isn't
   necessarily best at near-duplicate / "more like this"; benchmark it separately.

## 3. Changes the codebase needs first (Phase 0)

Small refactors that make experiments cheap and safe. None are done yet.

1. **One index per model/strategy.** Today `VectorStore` keeps a single file and *discards it*
   when the model name changes (`src/embeddings/store.js`), so you can't compare models
   without re-indexing each time. Change to `vectors/<embedderId>.json` (or a single SQLite
   file with an `embedder_id` column), selected by config.
2. **Embedder registry & config.** Replace the hard-wired `ClipEmbedder` with a registry like
   destinations have, and allow several named embedders:
   ```jsonc
   "embedding": {
     "default": "clip-b32",
     "embedders": {
       "clip-b32": { "type": "clip",   "model": "Xenova/clip-vit-base-patch32" },
       "clip-l14": { "type": "clip",   "model": "Xenova/clip-vit-large-patch14" },
       "voyage":   { "type": "voyage", "model": "voyage-multimodal-3", "apiKey": "$VOYAGE_API_KEY" }
     }
   }
   ```
   Tools take an optional `embedder` argument (default from config).
3. **Richer Embedder interface.** Add `id`, `dim`, `embedQuery(text)` vs `embedDocument(item)`
   (Voyage's `input_type` and some SigLIP/Jina setups treat them differently),
   `embedImages(buffers[])` for batching (APIs bill/limit per request), `maxBatch`,
   `thumbnail: { w, h }` (the size it wants), and `cost` metadata for the report.
4. **Privacy gate for remote embedders.** `indexPhotos` currently embeds *everything*,
   including blocked folders (fine locally, wrong for an upload). Remote embedders must skip
   blocked folders/photos, and should require an explicit opt-in per source
   (`"allowRemoteEmbedding": true`) because Dropbox collections like `Family/…` shouldn't be
   uploaded by accident. Add a test that a blocked photo's bytes are never passed to a
   remote embedder.
5. **Configurable thumbnail size.** Dropbox thumbnails are hardcoded to `w480h320`
   (`src/sources/dropbox.js`) — *smaller than the native input of ViT-L/14@336 or SigLIP-384*,
   which would quietly handicap bigger models. Take the size from the embedder; Dropbox offers
   larger fixed sizes (e.g. w640h480, w1024h768 **(verify list)**).
6. **Robust batch indexing.** Resume-safe (already incremental), configurable concurrency,
   retry with backoff on 429/5xx for APIs, and a per-run cost/time summary.
7. **Storage format.** JSON+base64 is fine to a few 10k photos. At 1024-d × 50k ≈ 200 MB —
   move to a binary Float32 file or SQLite before that. Brute-force cosine in JS is fine to
   ~100k vectors; beyond that consider an ANN index.

## 4. Evaluation set (the hard part — do this before comparing anything)

Public benchmarks (COCO, Flickr30k) tell you little about *your* photos, so build a small
private set.

**Format** — `bench/queries.json` (gitignored; see `bench/queries.example.json`):
```jsonc
{
  "queries": [
    { "id": "q1", "type": "object",  "text": "a dog on a beach",
      "relevant": ["main:Trips/Portugal/IMG_2041.jpg", "main:Trips/Portugal/IMG_2057.jpg"] },
    { "id": "q2", "type": "similar", "similarTo": "main:Food/ramen_01.jpg",
      "relevant": ["main:Food/ramen_03.jpg"] }
  ]
}
```
Use `source:path` rather than ids so labels survive re-scans and are readable.

**Size & coverage.** ~60–100 queries is enough to see big differences (not tiny ones).
Include each category, because models differ most by category:

`object` · `scene` · `colour/lighting` ("blue hour", "red door") · `mood/abstract` ("cozy") ·
`text-in-image` (signs, menus) · `counting/relations` ("two people on bikes") ·
`rare/specific` (landmarks, pets by name) · `negation-ish` (CLIP is bad at "no people") ·
`similar` (image→image) · `tag-aided` (query + `tags`/`folder` filter, the way the agent uses it).

**Getting labels without labelling the whole library.** Use *pooling* (as in TREC): run every
candidate system, take the union of each one's top-20 per query, and judge only that pool.
Judge with Claude as a VLM (`view_photo`-style, 0/1/2 relevance) and **hand-check a
~15% sample** to measure how much you trust the judge. Pooling matters: if you label only
the results of the baseline, you'll bias the benchmark toward the baseline. Anything not in
any pool counts as non-relevant (standard practice; note this slightly favours systems that
were in the pool, so add a new system's results to the pool when you add it, and re-judge).

**Hygiene.** Hold out ~20% of queries; don't tune templates/prompts on them. Fix random seeds
and record library snapshot size, since adding photos changes the numbers.

## 5. Harness (Phase 2)

`npm run bench -- --embedders clip-b32,clip-l14,voyage --strategies vector,vector+rewrite`

For each (embedder × strategy) it will:
1. ensure the index exists (reports index time, $ and bytes per photo),
2. run all queries via the *same* `PhotoBot.visualSearch` the tools use (so we benchmark the
   real code path, including filters),
3. score against labels,
4. write `bench/results/<timestamp>.json` plus a Markdown summary.

**Metrics** — per query then averaged, overall and *per category*:
nDCG@10 (primary), Recall@10, MRR, Precision@5, and "any relevant in top-5" (hit rate, which
matches how the agent uses results). Also: p50/p95 query latency, index photos/sec, total
index cost, vector bytes/photo.

**Statistics.** With ~100 queries, report a bootstrap 95% CI on the nDCG difference vs.
baseline (paired). Don't declare a winner on a 0.01 gap.

**Score calibration.** Raw cosine scales differ across models (CLIP text↔image sits around
0.2–0.35; others differ), so `minScore` can't be shared. The harness should report, per
model, the score distribution for relevant vs non-relevant results and the threshold that
maximises F1, and we store it in config per embedder.

## 6. Rollout order

| Round | Compare | Question answered |
|---|---|---|
| 0 | Phase 0 refactors + eval set + harness | can we measure at all? |
| 1 | CLIP B/32 vs B/16 vs L/14 | how much does model size buy? (same code, config only) |
| 2 | best CLIP vs SigLIP(2) vs Jina CLIP | is a newer local family better? |
| 3 | best local vs Voyage (+ one more API if wanted) | is paying/uploading worth it? Needs the privacy gate (§3.4) and a *non-private* eval subset. |
| 4 | strategies on the top 1–2 models: templates, rewrite, hybrid, rerank, captions | where does extra work buy quality? |
| 5 | decision + doc update | pick default, record numbers in `docs/embedding-results.md` |

## 7. Decision rule (agree on this *before* seeing results)

- Candidate must beat baseline nDCG@10 with the paired CI excluding zero, **and**
- improve hit-rate@5 on the categories you care most about (suggest: object, scene, mood), **and**
- stay within budget: index cost for your real library under a number you pick now,
  query latency under ~1 s for interactive use.
- If a hosted model wins by a small margin, prefer the local one (privacy, no key, no
  recurring cost). Require a clear win to justify uploads.
- Reranking/captions are judged separately as *add-ons* by quality gained per extra cost.

## 8. Risks & open questions

- **Judge bias:** an LLM judge may prefer results that match its own captions/strategy.
  Mitigate with the human-checked sample.
- **Library drift:** re-run the baseline whenever the library changes materially.
- **Dropbox thumbnails ≠ originals:** results measured on thumbnails reflect what the index
  actually sees; keep it that way, but note it when comparing with other people's numbers.
- **Terms/data handling:** confirm each API's retention and training policy before uploading
  personal photos; **(verify)**, don't assume.
- **Open question for you:** what's the library size, and is a subset free of private photos
  (for the hosted-model rounds)? That decides cost estimates and whether Round 3 is viable.
