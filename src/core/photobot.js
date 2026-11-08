import crypto from 'node:crypto';
import { State } from './state.js';
import { createSources } from '../sources/index.js';
import { createDestinations } from '../destinations/index.js';
import { VectorStore } from '../embeddings/store.js';
import { ClipEmbedder, cosine } from '../embeddings/clip.js';

/**
 * PhotoBot is the one place that knows how to search, pick, check and post photos.
 * The CLI, the HTTP API and the MCP server are thin wrappers around these methods.
 */
export class PhotoBot {
  constructor(config, { publicUrlFor, embedder } = {}) {
    this.config = config;
    this._embedder = embedder;
    this._store = null;
    this.state = new State(config.statePath);
    this.sources = createSources(config);
    const { destinations, errors } = createDestinations(config, { config, publicUrlFor });
    this.destinations = destinations;
    this.destinationErrors = errors;
    this._index = null;
  }

  // ---------- discovery ----------

  describe() {
    return {
      sources: Object.keys(this.sources),
      destinations: Object.entries(this.destinations).map(([name, d]) => ({ name, type: d.type, limits: d.limits })),
      misconfiguredDestinations: this.destinationErrors,
    };
  }

  async #assets(refresh = false) {
    if (!refresh && this._index && Date.now() - this._index.at < this.config.cacheSeconds * 1000) return this._index.assets;
    const lists = await Promise.all(Object.values(this.sources).map((s) => s.list({ fileTypes: this.config.fileTypes })));
    const assets = lists.flat();
    this._index = { at: Date.now(), assets };
    return assets;
  }

  #byId(assets, id) {
    const a = assets.find((x) => x.id === id);
    if (!a) throw new Error(`No photo with id "${id}" (ids come from search/random; the library may have changed — try refresh)`);
    return a;
  }

  decorate(a) {
    return { ...a, postedTo: this.state.postedTo({ id: a.id }) };
  }

  // ---------- search ----------

  /**
   * Filters: query (words matched against path), tags (all must match), folder (prefix),
   * source, after/before (ISO date on file modified time), notPostedTo (destination),
   * includeBlocked, sort: random | newest | oldest | name, limit, offset.
   */
  async #filter(f) {
    let assets = await this.#assets(f.refresh);
    const words = (f.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const tags = (f.tags ?? []).map((t) => t.toLowerCase());
    const after = f.after && new Date(f.after).getTime();
    const before = f.before && new Date(f.before).getTime();

    assets = assets.filter((a) => {
      if (f.source && a.source !== f.source) return false;
      if (f.folder && !(a.folder === f.folder || a.folder.startsWith(f.folder.replace(/\/$/, '') + '/'))) return false;
      if (tags.length && !tags.every((t) => a.tags.includes(t))) return false;
      const hay = a.path.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) return false;
      const t = new Date(a.modified).getTime();
      if (after && t < after) return false;
      if (before && t > before) return false;
      if (!f.includeBlocked && (this.state.isFolderBlocked(a.folder) || this.state.isPhotoBlocked({ id: a.id }))) return false;
      if (f.notPostedTo && this.state.wasPosted({ id: a.id }, f.notPostedTo)) return false;
      return true;
    });
    return assets;
  }

  async search(f = {}) {
    let assets = await this.#filter(f);

    const sort = f.sort ?? 'name';
    if (sort === 'random') assets = shuffle(assets);
    else if (sort === 'newest') assets.sort((a, b) => b.modified.localeCompare(a.modified));
    else if (sort === 'oldest') assets.sort((a, b) => a.modified.localeCompare(b.modified));
    else assets.sort((a, b) => a.path.localeCompare(b.path));

    const offset = f.offset ?? 0;
    const limit = f.limit ?? 20;
    return { total: assets.length, offset, photos: assets.slice(offset, offset + limit).map((a) => this.decorate(a)) };
  }

  async random(f = {}) {
    const { photos, total } = await this.search({ ...f, sort: 'random', limit: f.count ?? 1, offset: 0 });
    if (!photos.length) throw new Error('No photos match those filters (after excluding blocked and already-posted ones)');
    return { total, photos };
  }

  /** Folder tags with counts, so an agent can discover what the collection contains. */
  async tags({ source } = {}) {
    const counts = new Map();
    for (const a of await this.#assets()) {
      if (source && a.source !== source) continue;
      if (this.state.isFolderBlocked(a.folder) || this.state.isPhotoBlocked({ id: a.id })) continue;
      for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  }

  async read(id) {
    const asset = this.#byId(await this.#assets(), id);
    const bytes = await this.sources[asset.source].read(asset);
    return { asset: this.decorate(asset), bytes };
  }

  // ---------- visual search ----------

  get embedder() { return (this._embedder ??= new ClipEmbedder(this.config.embedding)); }

  get store() { return (this._store ??= new VectorStore(this.config.indexPath, this.embedder.model)); }

  /**
   * Embed photos that are new or changed. Works in batches (default 200) so a call
   * stays short; call again until `remaining` is 0. Individual failures (corrupt or
   * undecodable files) are reported and skipped, and retried on the next run.
   */
  async indexPhotos({ source, limit = 200, refresh = true } = {}) {
    const all = (await this.#assets(refresh)).filter((a) => !source || a.source === source);
    const todo = all.filter((a) => !this.store.get(a));
    const batch = todo.slice(0, limit);
    const failed = [];
    let done = 0;
    for (const a of batch) {
      try {
        const src = this.sources[a.source];
        const bytes = src.thumbnail ? await src.thumbnail(a) : await src.read(a);
        this.store.set(a, await this.embedder.embedImage(bytes));
        if (++done % 25 === 0) this.store.save();
      } catch (e) {
        failed.push({ path: `${a.source}:${a.path}`, error: e.message });
      }
    }
    if (done) this.store.save();
    return { total: all.length, indexed: all.length - todo.length + done, newlyIndexed: done, failed, remaining: todo.length - done - failed.length };
  }

  /**
   * Rank photos by what they look like. Give `text` ("dog on a beach", "red door at night")
   * and/or `similarTo` (a photo id). All the usual filters apply. Photos not yet indexed
   * are skipped and counted in `unindexed`.
   */
  async visualSearch({ text, similarTo, limit = 20, minScore, ...filters }) {
    if (!text && !similarTo) throw new Error('Give text and/or similarTo');
    const candidates = await this.#filter(filters);
    const queries = [];
    if (text) queries.push(await this.embedder.embedText(text));
    if (similarTo) {
      const ref = this.#byId(await this.#assets(), similarTo);
      let v = this.store.get(ref);
      if (!v) {
        const src = this.sources[ref.source];
        v = await this.embedder.embedImage(src.thumbnail ? await src.thumbnail(ref) : await src.read(ref));
        this.store.set(ref, v); this.store.save();
      }
      queries.push(v);
    }
    const scored = [];
    let unindexed = 0;
    for (const a of candidates) {
      if (a.id === similarTo) continue;
      const v = this.store.get(a);
      if (!v) { unindexed++; continue; }
      const score = queries.reduce((sum, q) => sum + cosine(q, v), 0) / queries.length;
      if (minScore === undefined || score >= minScore) scored.push({ a, score });
    }
    scored.sort((x, y) => y.score - x.score);
    return {
      matched: scored.length, unindexed,
      note: unindexed ? `${unindexed} matching photos are not indexed yet; run index_photos to include them` : undefined,
      photos: scored.slice(0, limit).map(({ a, score }) => ({ ...this.decorate(a), score: Math.round(score * 1000) / 1000 })),
    };
  }

  // ---------- posting ----------

  /**
   * Post one photo to one or more destinations. Returns one result per destination;
   * a failure on one never stops the others. Refuses (without force) anything that is
   * blocked, already posted there, or violates the destination's limits.
   */
  async post({ id, destinations, caption, tags, altText, force = false, dryRun = false }) {
    const { asset, bytes } = await this.read(id);
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    const finalTags = tags ?? asset.tags;
    const results = [];

    if (!force && (this.state.isFolderBlocked(asset.folder) || this.state.isPhotoBlocked({ id, hash }))) {
      return destinations.map((destination) => ({ destination, status: 'refused', reason: 'photo or folder is blocked' }));
    }

    for (const name of destinations) {
      const dest = this.destinations[name];
      if (!dest) {
        results.push({ destination: name, status: 'error', reason: this.destinationErrors[name] ?? `unknown destination "${name}"` });
        continue;
      }
      if (!force && this.state.wasPosted({ id, hash }, name)) {
        results.push({ destination: name, status: 'refused', reason: 'already posted there (pass force to repost)' });
        continue;
      }
      const problem = checkLimits(dest.limits, asset, bytes, caption);
      if (problem) { results.push({ destination: name, status: 'refused', reason: problem }); continue; }
      if (dryRun) { results.push({ destination: name, status: 'dry-run', wouldPost: { caption, tags: finalTags, altText } }); continue; }
      try {
        const res = await dest.post({ asset, bytes, caption, tags: finalTags, altText });
        this.state.recordPost({ id, hash, path: `${asset.source}:${asset.path}`, destination: name, url: res.url, caption, tags: finalTags });
        results.push({ destination: name, status: 'posted', ...res });
      } catch (e) {
        results.push({ destination: name, status: 'error', reason: e.message });
      }
    }
    return results;
  }

  // ---------- state ----------

  history(limit) { return this.state.history(limit); }
  block(args) { this.state.block(args); return this.state.data.blocked; }
  unblock(args) { this.state.unblock(args); return this.state.data.blocked; }
  blocked() { return this.state.data.blocked; }
}

function checkLimits(limits = {}, asset, bytes, caption) {
  if (limits.mimes && !limits.mimes.includes(asset.mime)) return `only ${limits.mimes.join(', ')} accepted, photo is ${asset.mime}`;
  if (limits.maxBytes && bytes.length > limits.maxBytes) return `photo is ${bytes.length} bytes, limit is ${limits.maxBytes}`;
  if (limits.captionMax && caption && [...caption].length > limits.captionMax) return `caption is longer than ${limits.captionMax} characters`;
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
