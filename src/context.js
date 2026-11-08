import crypto from 'node:crypto';
import { loadConfig } from './core/config.js';
import { PhotoBot } from './core/photobot.js';

/**
 * Build a PhotoBot. If a public base URL is given (needed by Instagram, which
 * pulls images from a URL), photos are exposed at <base>/media/<id>?sig=<hmac>.
 */
export function createBot({ configFile, publicBaseUrl = process.env.PHOTOBOT_PUBLIC_URL } = {}) {
  const config = loadConfig(configFile);
  const secret = config.mediaSecret ?? process.env.PHOTOBOT_MEDIA_SECRET ?? crypto.randomBytes(32).toString('hex');
  const sign = (id) => crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0, 32);
  const publicUrlFor = publicBaseUrl
    ? (asset) => `${publicBaseUrl.replace(/\/$/, '')}/media/${asset.id}?sig=${sign(asset.id)}`
    : undefined;
  return { bot: new PhotoBot(config, { publicUrlFor }), config, verifySig: (id, sig) => sig === sign(id) };
}
