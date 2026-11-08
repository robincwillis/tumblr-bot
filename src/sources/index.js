import { LocalSource } from './local.js';
import { DropboxSource } from './dropbox.js';

const TYPES = { local: LocalSource, dropbox: DropboxSource };

export function createSources(config) {
  const sources = {};
  for (const [name, cfg] of Object.entries(config.sources)) {
    const Type = TYPES[cfg.type ?? 'local'];
    if (!Type) throw new Error(`source "${name}": unknown type "${cfg.type}". Known: ${Object.keys(TYPES).join(', ')}`);
    sources[name] = new Type(name, cfg);
  }
  return sources;
}
