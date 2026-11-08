import { Outbox } from './outbox.js';
import { Tumblr } from './tumblr.js';
import { Mastodon } from './mastodon.js';
import { Bluesky } from './bluesky.js';
import { Instagram } from './instagram.js';
import { GooglePhotos } from './googlephotos.js';

/**
 * A Destination is { name, limits, post({asset, bytes, caption, tags, altText}) -> {id, url?} }.
 * limits: { maxBytes?, mimes?, captionMax? } is enforced by the service before post() runs.
 * To add one, write a class like the ones here and register it below.
 */
export const DESTINATION_TYPES = {
  outbox: Outbox, tumblr: Tumblr, mastodon: Mastodon,
  bluesky: Bluesky, instagram: Instagram, googlephotos: GooglePhotos,
};

export function createDestinations(config, ctx) {
  const out = {};
  const errors = {};
  for (const [name, cfg] of Object.entries(config.destinations)) {
    const Type = DESTINATION_TYPES[cfg.type ?? name];
    if (!Type) { errors[name] = `unknown type "${cfg.type}". Known: ${Object.keys(DESTINATION_TYPES).join(', ')}`; continue; }
    try { out[name] = Object.assign(new Type(name, cfg, ctx), { type: cfg.type ?? name }); }
    catch (e) { errors[name] = e.message; } // misconfigured destinations are reported, not fatal
  }
  return { destinations: out, errors };
}
