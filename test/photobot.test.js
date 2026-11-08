import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhotoBot } from '../src/core/photobot.js';
import { DEFAULTS } from '../src/core/config.js';
import { createHttpServer } from '../src/http.js';
import { DropboxSource } from '../src/sources/dropbox.js';
import { normalize } from '../src/embeddings/clip.js';

// Deterministic stand-in for CLIP: a bag-of-words hash. Fixture image bytes end with
// their own path, so "ramen" text lands near ramen.png — enough to test ranking & plumbing.
const bag = (str) => {
  const v = new Float32Array(64);
  for (const w of str.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return normalize(v);
};
const fakeEmbedder = () => ({
  model: 'fake', calls: 0,
  async embedText(t) { return bag(t); },
  async embedImage(b) { this.calls++; return bag(b.subarray(PNG.length).toString()); },
});

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
    indexPath: path.join(dir, 'vectors.json'),
    sources: { main: { path: photos } },
    destinations: { outbox: { path: path.join(dir, 'outbox') }, ...destinations },
  };
  const embedder = fakeEmbedder();
  return { dir, config, embedder, bot: new PhotoBot(config, { embedder }) };
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

test('index is incremental and survives restart; changed files are re-embedded', async () => {
  const { bot, config, embedder, dir } = fixture();
  let r = await bot.indexPhotos({ limit: 3 });
  assert.deepEqual([r.newlyIndexed, r.remaining], [3, 1]);
  r = await bot.indexPhotos({});
  assert.deepEqual([r.newlyIndexed, r.remaining, r.indexed], [1, 0, 4]);
  assert.equal(embedder.calls, 4);
  // new process, same index file: nothing to do
  const bot2 = new PhotoBot(config, { embedder });
  assert.equal((await bot2.indexPhotos({})).newlyIndexed, 0);
  assert.equal(embedder.calls, 4);
  // edit one file -> only that one is re-embedded
  const f = path.join(config.sources.main.path, 'Food/ramen.png');
  fs.appendFileSync(f, ' spicy miso');
  const r3 = await new PhotoBot(config, { embedder }).indexPhotos({});
  assert.equal(r3.newlyIndexed, 1);
  // a different model invalidates the index
  const other = new PhotoBot(config, { embedder: { ...embedder, model: 'other' } });
  assert.equal((await other.indexPhotos({})).newlyIndexed, 4);
  assert.ok(fs.existsSync(path.join(dir, 'vectors.json')));
});

test('visual search ranks by content, honours filters and blocks, reports unindexed', async () => {
  const { bot } = fixture();
  await bot.indexPhotos({ limit: 2 });
  let r = await bot.visualSearch({ text: 'ramen' });
  assert.ok(r.unindexed > 0 && /index_photos/.test(r.note));
  await bot.indexPhotos({});
  r = await bot.visualSearch({ text: 'ramen' });
  assert.equal(r.unindexed, 0);
  assert.equal(r.photos[0].name, 'ramen.png');
  assert.ok(r.photos[0].score > r.photos[1].score);
  r = await bot.visualSearch({ text: 'japan temple', tags: ['japan'] });
  assert.equal(r.photos[0].name, 'temple.png');
  assert.equal(r.matched, 2);
  bot.block({ folder: 'Family/Private' });
  assert.ok(!(await bot.visualSearch({ text: 'kid private family' })).photos.some((p) => p.name === 'kid.png'));
  await assert.rejects(bot.visualSearch({}), /text and\/or similarTo/);
});

test('similarTo finds look-alikes, excludes itself, and indexes the reference on demand', async () => {
  const { bot } = fixture();
  const temple = await one(bot, 'temple');
  const r = await bot.visualSearch({ similarTo: temple.id });
  assert.ok(!r.photos.some((p) => p.id === temple.id));
  assert.equal(r.unindexed, 3); // others weren't indexed, reference was
  await bot.indexPhotos({});
  const r2 = await bot.visualSearch({ similarTo: temple.id });
  assert.equal(r2.photos[0].name, 'street.png'); // shares the Trips/Japan words
});

test('Dropbox source: paginates, filters, refreshes token, escapes non-ASCII, retries 429', async (t) => {
  const calls = [];
  let tokens = 0, throttled = false;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers });
    if (u.endsWith('/oauth2/token')) return json({ access_token: `tok${++tokens}`, expires_in: 14400 });
    if (u.endsWith('files/list_folder')) return json({
      has_more: true, cursor: 'c1',
      entries: [
        { '.tag': 'file', name: 'a.jpg', path_display: '/Photos/Trips/Café/a.jpg', size: 10, content_hash: 'h1', client_modified: '2020-01-01T00:00:00Z' },
        { '.tag': 'folder', name: 'Trips', path_display: '/Photos/Trips' },
        { '.tag': 'file', name: 'doc.pdf', path_display: '/Photos/doc.pdf', size: 1 },
      ],
    });
    if (u.endsWith('list_folder/continue')) return json({ has_more: false, entries: [
      { '.tag': 'file', name: 'b.PNG', path_display: '/Photos/b.PNG', size: 5, content_hash: 'h2', client_modified: '2021-01-01T00:00:00Z' },
      { '.tag': 'file', name: 'hidden.jpg', path_display: '/Photos/.cache/hidden.jpg', size: 5, content_hash: 'h3' },
    ] });
    if (u.endsWith('get_thumbnail_v2') && !throttled) { throttled = true; return json({}, 429, { 'retry-after': '0' }); }
    return new Response(Buffer.from('bytes'), { status: 200 });
  });
  const src = new DropboxSource('db', { path: '/Photos', appKey: 'k', appSecret: 's', refreshToken: 'r' });
  const assets = await src.list({ fileTypes: ['image/jpeg', 'image/png'] });
  assert.deepEqual(assets.map((a) => [a.path, a.folder, a.version]), [['Trips/Café/a.jpg', 'Trips/Café', 'h1'], ['b.PNG', '', 'h2']]);
  assert.deepEqual(assets[0].tags, ['trips', 'café']);
  assert.equal(tokens, 1);
  assert.equal(calls.find((c) => c.u.endsWith('list_folder')).init.headers.Authorization, 'Bearer tok1');
  assert.equal((await src.thumbnail(assets[0])).toString(), 'bytes');
  const thumb = calls.filter((c) => c.u.endsWith('get_thumbnail_v2')).at(-1);
  assert.match(thumb.init.headers['Dropbox-API-Arg'], /Caf\\u00e9/); // ASCII-safe header
  assert.ok(!/[^\x20-\x7e]/.test(thumb.init.headers['Dropbox-API-Arg']));
  assert.equal(calls.filter((c) => c.u.endsWith('get_thumbnail_v2')).length, 2); // 429 then success
  assert.throws(() => new DropboxSource('x', {}), /accessToken/);
});

test('Dropbox thumbnails (not originals) feed the index', async () => {
  const { config } = fixture();
  const seen = [];
  const src = {
    name: 'db', list: async () => [{ id: 'z1', source: 'db', path: 'x.jpg', name: 'x.jpg', mime: 'image/jpeg', size: 1, modified: '2020-01-01', version: 'v', folder: '', tags: [] }],
    read: async () => { seen.push('read'); return Buffer.concat([PNG, Buffer.from('x')]); },
    thumbnail: async () => { seen.push('thumb'); return Buffer.concat([PNG, Buffer.from('x')]); },
  };
  const bot = new PhotoBot({ ...config, sources: {} }, { embedder: fakeEmbedder() });
  bot.sources = { db: src };
  await bot.indexPhotos({});
  assert.deepEqual(seen, ['thumb']);
});

test('Dropbox: an expired token (401) is refreshed once and the call retried', async (t) => {
  let tokens = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: `tok${++tokens}`, expires_in: 14400 }));
    if (init.headers.Authorization === 'Bearer tok1') return new Response('expired', { status: 401 });
    return new Response(JSON.stringify({ has_more: false, entries: [] }));
  });
  const src = new DropboxSource('db', { appKey: 'k', appSecret: 's', refreshToken: 'r' });
  assert.deepEqual(await src.list({}), []);
  assert.equal(tokens, 2);
});
