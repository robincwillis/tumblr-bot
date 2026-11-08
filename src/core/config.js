import fs from 'node:fs';
import path from 'node:path';

/**
 * Config lives in photobot.config.json (or $PHOTOBOT_CONFIG). Any string value
 * of the form "$NAME" is replaced with process.env.NAME so secrets can stay
 * out of the file.
 */
export const DEFAULTS = {
  statePath: 'state.json',
  fileTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff'],
  sources: {},
  destinations: {},
};

function interpolate(value) {
  if (typeof value === 'string' && /^\$[A-Z0-9_]+$/.test(value)) {
    const v = process.env[value.slice(1)];
    if (v === undefined) return undefined;
    return v;
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

export function loadConfig(file = process.env.PHOTOBOT_CONFIG || 'photobot.config.json') {
  const resolved = path.resolve(file);
  let raw = {};
  if (fs.existsSync(resolved)) {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } else if (process.env.PHOTOBOT_CONFIG) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const cfg = { ...DEFAULTS, ...interpolate(raw) };
  const base = path.dirname(resolved);
  cfg.statePath = path.resolve(base, cfg.statePath);
  // Relative paths in the file are relative to the file, not the cwd.
  for (const s of Object.values(cfg.sources)) if (s.path) s.path = path.resolve(base, s.path);
  for (const [name, d] of Object.entries(cfg.destinations)) {
    if ((d.type ?? name) === 'outbox') d.path = path.resolve(base, d.path ?? 'outbox');
  }
  return cfg;
}
