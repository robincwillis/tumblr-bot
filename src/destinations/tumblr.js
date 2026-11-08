import { Readable } from 'node:stream';
import tumblr from 'tumblr.js';

/** config: { blog, consumer_key, consumer_secret, token, token_secret } */
export class Tumblr {
  static label = 'Tumblr';
  constructor(name, cfg) {
    for (const k of ['blog', 'consumer_key', 'consumer_secret', 'token', 'token_secret']) {
      if (!cfg[k]) throw new Error(`destination "${name}" (tumblr): "${k}" is required`);
    }
    this.name = name;
    this.blog = cfg.blog;
    this.client = new tumblr.Client({
      consumer_key: cfg.consumer_key,
      consumer_secret: cfg.consumer_secret,
      token: cfg.token,
      token_secret: cfg.token_secret,
    });
    this.limits = {};
  }
  async post({ bytes, caption, tags, altText }) {
    const content = [{ type: 'image', media: Readable.from(bytes), alt_text: altText }];
    if (caption) content.push({ type: 'text', text: caption });
    const res = await this.client.createPost(this.blog, { content, tags: tags.join(',') });
    // Response shape differs across tumblr.js versions; id_string / id are both seen.
    const id = res?.id_string ?? res?.id ?? res?.response?.id;
    return { id: String(id ?? ''), url: id ? `https://${this.blog.replace(/^https?:\/\//, '')}/post/${id}` : undefined };
  }
}
