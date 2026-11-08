import fs from 'node:fs';
import path from 'node:path';

/**
 * Vector index on disk. Keyed by "source:path"; each entry remembers the asset's
 * `version` (mtime/size or Dropbox content hash) so edited files are re-embedded
 * and unchanged ones never are. A different model invalidates everything.
 */
export class VectorStore {
  constructor(file, model) {
    this.file = file;
    this.model = model;
    this.items = new Map(); // key -> { version, vec: Float32Array }
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.model === model) {
        for (const [k, e] of Object.entries(j.items)) {
          const b = Buffer.from(e.v, 'base64');
          this.items.set(k, { version: e.version, vec: new Float32Array(b.buffer, b.byteOffset, b.length / 4) });
        }
      }
    }
  }

  static key(asset) { return `${asset.source}:${asset.path}`; }

  get(asset) {
    const e = this.items.get(VectorStore.key(asset));
    return e && e.version === asset.version ? e.vec : undefined;
  }

  set(asset, vec) { this.items.set(VectorStore.key(asset), { version: asset.version, vec }); }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const items = {};
    for (const [k, e] of this.items) {
      items[k] = { version: e.version, v: Buffer.from(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength).toString('base64') };
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ model: this.model, items }));
    fs.renameSync(tmp, this.file);
  }
}
