import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent bot state: what has been posted where, and what must never be
 * posted. Stored as one JSON file, written atomically.
 *
 *   posted:  [{ id, hash, path, destination, postedAt, url?, caption?, tags? }]
 *            id = stable asset id (cheap, used for searching); hash = content sha1
 *            (catches renamed / duplicate copies of the same file at post time).
 *   blocked: { folders: ["Family/Private"], photos: ["<asset id or content hash>"] }
 */
export class State {
  constructor(file) {
    this.file = file;
    this.data = { posted: [], blocked: { folders: [], photos: [] } };
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = {
        posted: loaded.posted ?? [],
        blocked: { folders: loaded.blocked?.folders ?? [], photos: loaded.blocked?.photos ?? [] },
      };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** ref: { id?, hash? } — matches either. */
  postedTo({ id, hash }) {
    return [...new Set(this.data.posted
      .filter((p) => (id && p.id === id) || (hash && p.hash === hash))
      .map((p) => p.destination))];
  }

  wasPosted(ref, destination) {
    return this.postedTo(ref).includes(destination);
  }

  recordPost(entry) {
    this.data.posted.push({ postedAt: new Date().toISOString(), ...entry });
    this.save();
  }

  history(limit = 20) {
    return this.data.posted.slice(-limit).reverse();
  }

  isFolderBlocked(relFolder) {
    const f = relFolder.split(path.sep).join('/');
    return this.data.blocked.folders.some((b) => f === b || f.startsWith(b + '/'));
  }

  isPhotoBlocked({ id, hash }) {
    const b = this.data.blocked.photos;
    return (id && b.includes(id)) || (hash && b.includes(hash)) || false;
  }

  block({ folder, photo }) {
    if (folder && !this.data.blocked.folders.includes(folder)) this.data.blocked.folders.push(folder);
    if (photo && !this.data.blocked.photos.includes(photo)) this.data.blocked.photos.push(photo);
    this.save();
  }

  unblock({ folder, photo }) {
    if (folder) this.data.blocked.folders = this.data.blocked.folders.filter((f) => f !== folder);
    if (photo) this.data.blocked.photos = this.data.blocked.photos.filter((h) => h !== photo);
    this.save();
  }
}
