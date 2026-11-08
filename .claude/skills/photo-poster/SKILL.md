---
name: photo-poster
description: Find photos in the user's personal collection and post them to Tumblr, Instagram, Bluesky, Mastodon, Google Photos or other destinations. Use when the user wants to browse/search their photos, pick something to share, write a caption, or post a photo anywhere.
---

# Photo poster

You drive the `photobot` tools (MCP server `photobot`; if MCP isn't connected, run the same
tools as `node src/cli.js <tool> --flag value` from the repo root — output is JSON).

## Workflow

1. **Orient.** Call `describe` for the sources, the destinations (and their limits) and the
   block list. If a destination appears under `misconfiguredDestinations`, tell the user what
   credential is missing instead of trying it. Call `list_tags` if you need to know what's in
   the collection — tags are derived from folder names (`Trips/Japan/2019` → trips, japan, 2019).
2. **Find candidates.** If the user describes what the photo *looks like* ("a dog on a beach",
   "moody street at night", "more like this one"), use `find_photos_by_content`. If it reports
   `unindexed` photos or returns nothing, run `index_photos` (repeat until `remaining` is 0; the
   first run is slow, so tell the user) and retry. Scores are only good for ranking, so always
   `view_photo` the top few to confirm before picking. For path/folder/date requests
   ("the ramen shots from Japan") use `search_photos`;
   `random_photos` for "surprise me". Pass `notPostedTo: "<destination>"` so you don't repeat
   yourself. Results are metadata only.
3. **Look before you post.** `view_photo` returns the actual image. Check it is a good,
   appropriate photo: sharp, nothing private (documents, screens, IDs, children's faces the
   user hasn't cleared, addresses). Folder names are hints, not guarantees. If it's a poor
   pick, choose another rather than asking.
4. **Write the post.** Short, in the user's voice if they've shown one. Always write `altText`
   (one plain sentence describing what's visible). Leave `tags` unset to use folder tags, or
   pass your own. Respect destination limits (Bluesky: 300 chars, ≤976 KB image; Instagram:
   JPEG only, 2200 chars, needs a public URL; Mastodon: 500 chars).
5. **Preview, then confirm.** Run `post_photo` with `dryRun: true`, show the user the photo
   id/path, caption, tags and destinations, and **ask before posting** — posts are public and
   can't be undone from here. Skip the confirmation only if the user explicitly told you to
   post without asking (e.g. a scheduled "post one photo a day" task).
6. **Post and report.** `post_photo` without `dryRun`. Report each destination's result and
   URL. Failures on one destination don't affect others; report them honestly and don't retry
   a `refused` result with `force`.

## Rules

- Never use `force` unless the user explicitly asks to repost or to override a block.
- If the user says "never post this / that folder", call `block` right away.
- A `refused: already posted` means it was posted there before — pick another photo.
- Don't invent destinations; only use names `describe` returns.
- Never print or ask for credentials in chat; they live in `photobot.config.json` / env vars.

## Recurring posting

For "post a random photo every day", use a scheduled task whose prompt says to: run
`random_photos` with `notPostedTo`, `view_photo` to vet it (skip & pick again if unsuitable,
block obviously private folders), then `post_photo` to the named destinations with a caption
and alt text. State (what was posted, what's blocked) persists in `state.json`.
