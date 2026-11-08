# photobot

Search your personal photo collection and post to wherever you share: **Tumblr, Instagram,
Bluesky, Mastodon, Google Photos**, or a dry-run folder. Originally a Tumblr-only script; now
a small toolkit with three interchangeable front doors over one core:

```
 sources ──►  PhotoBot core  ──► destinations
 local folders   search · visual search · random · dedupe     tumblr · instagram · bluesky
 dropbox         block · history                              mastodon · googlephotos · outbox
                     ▲
        one tool registry (src/tools.js)
        ┌────────────┼─────────────┐
   MCP server     HTTP API         CLI
 (Claude & other   (REST + OpenAPI)  (humans, cron)
  agents) + skill
```

The agent skill (`.claude/skills/photo-poster`) teaches Claude the workflow: search → *look at
the photo* → caption + alt text → dry-run → confirm → post.

## Setup

```sh
npm install
cp photobot.config.example.json photobot.config.json   # edit; gitignored
```

Config values like `"$TUMBLR_TOKEN"` are read from the environment, so secrets needn't live in
the file. Delete the destinations you don't use; start with just `outbox` to try things safely.
Tags come from folder names: `Trips/Japan/2019/x.jpg` → `trips`, `japan`, `2019`.

### Use it from Claude (MCP + skill)

Open this repo in Claude Code: `.mcp.json` registers the server and the skill loads automatically.
For Claude Desktop or another client, point it at `node /path/to/src/mcp.js` with
`PHOTOBOT_CONFIG=/path/to/photobot.config.json`. Then just ask: *"post a random photo from my
Japan trip to Bluesky and Tumblr"*.

### CLI

```sh
node src/cli.js describe
node src/cli.js search_photos --tags japan --sort newest --limit 5
node src/cli.js random_photos --notPostedTo tumblr
node src/cli.js post_photo --id <id> --destinations tumblr,bluesky --caption "Kyoto" --dryRun
node src/cli.js help post_photo
```

### HTTP API

```sh
PHOTOBOT_API_KEY=secret node src/http.js        # 127.0.0.1:8080; non-loopback requires a key
curl -H 'Authorization: Bearer secret' localhost:8080/openapi.json
curl -H 'Authorization: Bearer secret' -d '{"tags":["food"]}' localhost:8080/tools/random_photos
```

## Sources

| Type | Config | Notes |
|---|---|---|
| `local` | `path` | Recursively scans a folder. |
| `dropbox` | `path`, plus `appKey`/`appSecret`/`refreshToken` (or a short-lived `accessToken`) | Create an app at dropbox.com/developers/apps with scopes `files.metadata.read` and `files.content.read`, then get a refresh token via the OAuth code flow with `token_access_type=offline`. Listing a big Dropbox is slow, so set `"cacheSeconds": 600`. Indexing uses Dropbox's small thumbnails, so originals are only downloaded when you view or post a photo. |

## Searching by what's in the photo

`find_photos_by_content` takes a description (`"dog on a beach"`, `"red door at night"`) and/or
`similarTo` a photo id, and ranks photos by visual similarity. It combines with every other
filter (`tags`, `folder`, `after`, `notPostedTo`, …) and never returns blocked photos.

It uses CLIP, run **locally** through `@huggingface/transformers` (an optional dependency;
no API key, and your photos are never uploaded). Build the index first, in batches:

```sh
node src/cli.js index_photos --limit 500       # repeat until "remaining": 0
node src/cli.js find_photos_by_content --text "sunset over water" --notPostedTo bluesky
node src/cli.js find_photos_by_content --similarTo <id>
```

The first run downloads the model (~150 MB, from huggingface.co) and embeds on CPU, roughly
0.1–0.5 s per photo, so a large library takes a while once. After that only new or changed
photos are processed. Vectors live in `vectors.json` (gitignored); changing
`embedding.model` rebuilds them. To use a different provider, implement
`{ model, embedText, embedImage }` (see `src/embeddings/clip.js`).

Planning to try other CLIP/SigLIP models, Voyage, hybrid search and reranking? See
[docs/embedding-experiments.md](docs/embedding-experiments.md) for the benchmark plan.

CLIP is good at objects, scenes and colours, and weak at counting, reading text and fine
detail, so the skill has Claude confirm top hits with `view_photo`.

## Destinations

| Type | Needs | Notes |
|---|---|---|
| `outbox` | nothing | Copies photo + JSON sidecar to a folder. Dry runs. |
| `tumblr` | OAuth1 keys from tumblr.com/oauth/apps | Posts via the NPF `createPost` API. |
| `bluesky` | handle + [app password](https://bsky.app/settings/app-passwords) | Image ≤ 976 KB, text ≤ 300 chars (enforced). |
| `mastodon` | instance URL + access token (`write:media write:statuses`) | Text ≤ 500 chars. |
| `instagram` | Business/Creator account, Graph API `igUserId` + token | **JPEG only, and Instagram fetches the image from a public URL**: run `PHOTOBOT_PUBLIC_URL=https://your-tunnel.example node src/http.js` (ngrok/Cloudflare Tunnel) *and* run posts through that same process. Photos are served at signed `/media/<id>?sig=` links. |
| `googlephotos` | OAuth client + refresh token, scope `photoslibrary.appendonly` | Upload-only: since 2025 the Library API can't read your existing library, so Google Photos is a destination, not a source. |

> The Bluesky, Mastodon, Instagram and Google Photos adapters follow the providers' documented
> APIs and the Bluesky path is covered by a mocked-network test, but none have been run against
> the live services. Try each with a throwaway post first.

## Safety rails

- Never picks blocked folders/photos (`block`), and hides them from tags and search.
- Refuses to post the same photo to the same destination twice — by file id *and* content hash,
  so renamed copies are caught. `force` overrides.
- Destination limits (size, type, caption length) are checked before any network call.
- One destination failing never stops the others; each gets its own result.
- State (history, blocklist) is a single atomic-written `state.json`.

## Extending

- **New destination**: add a class with `post({asset, bytes, caption, tags, altText}) → {id, url}`
  and `limits`, register it in `src/destinations/index.js`.
- **New source** (S3, Immich…): implement `list({fileTypes})` and `read(asset)` (and optionally a
  cheap `thumbnail(asset)`) like `src/sources/dropbox.js`; register in `src/sources/index.js`.
- **New tool**: add an entry to `src/tools.js`; it shows up in MCP, HTTP and CLI automatically.

## Tests

`npm test` (Node ≥ 20, no network needed). Image search is tested with a fake embedder and
Dropbox with a mocked API; **neither the real CLIP model nor the live Dropbox API has been run.**
