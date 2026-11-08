# photobot

Search your personal photo collection and post to wherever you share: **Tumblr, Instagram,
Bluesky, Mastodon, Google Photos**, or a dry-run folder. Originally a Tumblr-only script; now
a small toolkit with three interchangeable front doors over one core:

```
 sources ──►  PhotoBot core  ──► destinations
 local folders   search · random · dedupe · block · history     tumblr · instagram · bluesky
 (add your own)                                                mastodon · googlephotos · outbox
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
- **New source** (Dropbox, S3, Immich…): implement `list({fileTypes})` and `read(asset)` like
  `src/sources/local.js`, register in `src/sources/index.js`.
- **New tool**: add an entry to `src/tools.js`; it shows up in MCP, HTTP and CLI automatically.

## Tests

`npm test` (Node ≥ 20, no network needed).
