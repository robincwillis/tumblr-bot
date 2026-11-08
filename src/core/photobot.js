import crypto from 'node:crypto';
import { State } from './state.js';
import { createSources } from '../sources/index.js';
import { createDestinations } from '../destinations/index.js';

const INDEX_TTL_MS = 60_000;

/**
 * PhotoBot is the one place that knows how to search, pick, check and post photos.
 * The CLI, the HTTP API and the MCP server are thin wrappers around these methods.
 */
export class PhotoBot {
  constructor(config, { publicUrlFor } = {}) {
    this.config = config;
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
    if (!refresh && this._index && Date.now() - this._index.at < INDEX_TTL_MS) return this._index.assets;
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
  async search(f = {}) {
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
