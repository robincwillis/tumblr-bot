import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhotoBot } from '../src/core/photobot.js';
import { DEFAULTS } from '../src/core/config.js';
import { createHttpServer } from '../src/http.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fixture(destinations = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobot-'));
  const photos = path.join(dir, 'photos');
  for (const f of ['Trips/Japan/temple.png', 'Trips/Japan/street.png', 'Family/Private/kid.png', 'Food/ramen.png']) {
    fs.mkdirSync(path.dirname(path.join(photos, f)), { recursive: true });
    fs.writeFileSync(path.join(photos, f), Buffer.concat([PNG, Buffer.from(f)]));
  }
  fs.writeFileSync(path.join(photos, 'notes.txt'), 'not a photo');
  const config = {
    ...DEFAULTS,
    statePath: path.join(dir, 'state.json'),
    sources: { main: { path: photos } },
    destinations: { outbox: { path: path.join(dir, 'outbox') }, ...destinations },
  };
  return { dir, config, bot: new PhotoBot(config) };
}

const one = async (bot, query) => (await bot.search({ query })).photos[0];

test('indexes only images and derives tags from folders', async () => {
  const { bot } = fixture();
  const { total, photos } = await bot.search({});
  assert.equal(total, 4);
  assert.deepEqual(photos.find((p) => p.name === 'temple.png').tags, ['trips', 'japan']);
});

test('filters by tags, query and folder', async () => {
  const { bot } = fixture();
  assert.equal((await bot.search({ tags: ['japan'] })).total, 2);
  assert.equal((await bot.search({ query: 'ramen' })).total, 1);
  assert.equal((await bot.search({ folder: 'Trips' })).total, 2);
  assert.equal((await bot.search({ tags: ['japan', 'food'] })).total, 0);
});

test('blocked folders disappear from search, random and tags', async () => {
  const { bot } = fixture();
  bot.block({ folder: 'Family' });
  assert.equal((await bot.search({})).total, 3);
  for (let i = 0; i < 20; i++) assert.notEqual((await bot.random({})).photos[0].folder, 'Family/Private');
  assert.ok(!(await bot.tags()).some((t) => t.tag === 'private'));
});

test('post records history, refuses repeats, and search can hide posted', async () => {
  const { bot, dir } = fixture();
  const photo = await one(bot, 'ramen');
  const [first] = await bot.post({ id: photo.id, destinations: ['outbox'], caption: 'noodles' });
  assert.equal(first.status, 'posted');
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 2);
  const [again] = await bot.post({ id: photo.id, destinations: ['outbox'] });
  assert.equal(again.status, 'refused');
  assert.match(again.reason, /already posted/);
  assert.equal((await bot.search({ notPostedTo: 'outbox' })).total, 3);
  assert.equal(bot.history()[0].caption, 'noodles');
  const [forced] = await bot.post({ id: photo.id, destinations: ['outbox'], force: true });
  assert.equal(forced.status, 'posted');
});

test('dedupes by content hash even if the same bytes live at another path', async () => {
  const { bot, config } = fixture();
  const root = config.sources.main.path;
  const a = await one(bot, 'ramen');
  await bot.post({ id: a.id, destinations: ['outbox'] });
  fs.copyFileSync(path.join(root, 'Food/ramen.png'), path.join(root, 'Food/ramen-copy.png'));
  const b = (await bot.search({ query: 'ramen-copy', refresh: true })).photos[0];
  const [r] = await bot.post({ id: b.id, destinations: ['outbox'] });
  assert.equal(r.status, 'refused');
});

test('blocked photo cannot be posted; dryRun posts nothing', async () => {
  const { bot } = fixture();
  const kid = await one(bot, 'kid');
  bot.block({ folder: 'Family/Private' });
  const [r] = await bot.post({ id: kid.id, destinations: ['outbox'] });
  assert.equal(r.status, 'refused');
  const [dry] = await bot.post({ id: (await one(bot, 'ramen')).id, destinations: ['outbox'], dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(bot.history().length, 0);
});

test('destination limits are enforced and one failure does not stop others', async () => {
  const { bot } = fixture({ jpegOnly: { type: 'instagram', igUserId: '1', accessToken: 't' } });
  const results = await bot.post({ id: (await one(bot, 'ramen')).id, destinations: ['jpegOnly', 'nope', 'outbox'] });
  assert.match(results[0].reason, /only image\/jpeg/);
  assert.equal(results[1].status, 'error');
  assert.equal(results[2].status, 'posted');
});

test('misconfigured destinations are reported, not fatal', () => {
  const { bot } = fixture({ bsky: { type: 'bluesky' } });
  assert.match(bot.describe().misconfiguredDestinations.bsky, /identifier/);
});

test('bluesky posts with hashtag facets (mocked network)', async (t) => {
  const { bot } = fixture({ bsky: { type: 'bluesky', identifier: 'me.bsky.social', appPassword: 'pw' } });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const body = u.endsWith('createSession') ? { accessJwt: 'jwt', did: 'did:plc:1', handle: 'me.bsky.social' }
      : u.endsWith('uploadBlob') ? { blob: { $type: 'blob', ref: { $link: 'x' } } }
      : { uri: 'at://did:plc:1/app.bsky.feed.post/abc' };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const [r] = await bot.post({ id: (await one(bot, 'ramen')).id, destinations: ['bsky'], caption: 'yum' });
  assert.equal(r.status, 'posted');
  assert.equal(r.url, 'https://bsky.app/profile/me.bsky.social/post/abc');
  const record = JSON.parse(calls[2].init.body).record;
  assert.equal(record.text, 'yum #food');
  assert.deepEqual(record.facets[0].index, { byteStart: 4, byteEnd: 9 });
});

test('HTTP API: auth, tool call, validation, signed media', async () => {
  const { bot } = fixture();
  process.env.PHOTOBOT_API_KEY = 'secret';
  const server = createHttpServer({ bot, config: {}, verifySig: (id, sig) => sig === 'good' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/tools`)).status, 401);
    const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
    const call = (name, body) => fetch(`${base}/tools/${name}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const { data } = await (await call('search_photos', { tags: ['food'] })).json();
    assert.equal(data.total, 1);
    assert.equal((await call('search_photos', { limit: 0 })).status, 400);
    const id = data.photos[0].id;
    assert.equal((await fetch(`${base}/media/${id}?sig=bad`)).status, 401);
    const media = await fetch(`${base}/media/${id}?sig=good`);
    assert.equal(media.headers.get('content-type'), 'image/png');
    const spec = await (await fetch(`${base}/openapi.json`, { headers: auth })).json();
    assert.ok(spec.paths['/tools/post_photo']);
  } finally {
    delete process.env.PHOTOBOT_API_KEY;
    server.close();
  }
});
