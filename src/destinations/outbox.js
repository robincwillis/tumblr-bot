import fs from 'node:fs/promises';
import path from 'node:path';

/** Dry-run destination: copies the photo plus a JSON sidecar into a folder. Needs no credentials. */
export class Outbox {
  static label = 'Outbox folder (dry run)';
  constructor(name, cfg, ctx) {
    this.name = name;
    this.dir = path.resolve(cfg.path ?? "outbox");
    this.limits = {};
  }
  async post({ asset, bytes, caption, tags, altText }) {
    await fs.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}-${asset.name}`;
    await fs.writeFile(path.join(this.dir, base), bytes);
    await fs.writeFile(path.join(this.dir, `${base}.json`), JSON.stringify({ caption, tags, altText, asset }, null, 2));
    return { id: base, url: `file://${path.join(this.dir, base)}` };
  }
}
