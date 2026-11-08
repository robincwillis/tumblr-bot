import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()];

/**
 * A Source lists photos and reads their bytes. Implement { name, list(), read(asset) }
 * to add Dropbox, S3, an Immich server, etc. Asset shape:
 *   { id, source, path (source-relative), name, mime, size, modified (ISO),
 *   version (changes when content changes), folder, tags[] }
 * Optional: thumbnail(asset) -> small image bytes, used for embedding when cheaper than read().
 *
 * Local folders: tags come from the directory names ("Trips/Japan/2019" -> trips, japan, 2019),
 * the same trick the original bot used.
 */
export class LocalSource {
  constructor(name, { path: root }) {
    if (!root) throw new Error(`source "${name}": "path" is required`);
    this.name = name;
    this.root = path.resolve(root);
  }

  async list({ fileTypes }) {
    const out = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        const mime = mimeFor(entry.name);
        if (!mime || (fileTypes && !fileTypes.includes(mime))) continue;
        const stat = await fs.stat(full);
        const rel = path.relative(this.root, full).split(path.sep).join('/');
        const folder = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
        out.push({
          id: crypto.createHash('sha1').update(`${this.name}:${rel}`).digest('hex').slice(0, 16),
          source: this.name,
          path: rel,
          name: entry.name,
          mime,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          version: `${stat.size}-${Math.floor(stat.mtimeMs)}`,
          folder,
          tags: folder ? folder.toLowerCase().split('/') : [],
        });
      }
    };
    await walk(this.root);
    return out;
  }

  async read(asset) {
    const full = path.resolve(this.root, asset.path);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Path escapes source root');
    return fs.readFile(full);
  }
}
