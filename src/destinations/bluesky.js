/** config: { identifier: "you.bsky.social", appPassword, service?: "https://bsky.social" } */
export class Bluesky {
  static label = 'Bluesky';
  constructor(name, cfg) {
    if (!cfg.identifier || !cfg.appPassword) throw new Error(`destination "${name}" (bluesky): "identifier" and "appPassword" are required`);
    this.name = name;
    this.service = (cfg.service ?? 'https://bsky.social').replace(/\/$/, '');
    this.identifier = cfg.identifier;
    this.appPassword = cfg.appPassword;
    // Bluesky rejects image blobs over ~976 KB and posts over 300 graphemes.
    this.limits = { maxBytes: 976 * 1024, captionMax: 300 };
  }
  async #xrpc(method, body, { token, raw, contentType } = {}) {
    const res = await fetch(`${this.service}/xrpc/${method}`, {
      method: 'POST',
      headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': contentType ?? 'application/json' },
      body: raw ?? JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bluesky ${method}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async post({ asset, bytes, caption, tags, altText }) {
    const session = await this.#xrpc('com.atproto.server.createSession', { identifier: this.identifier, password: this.appPassword });
    const { blob } = await this.#xrpc('com.atproto.repo.uploadBlob', null, { token: session.accessJwt, raw: bytes, contentType: asset.mime });

    // Hashtags need "facets" with UTF-8 byte offsets to be clickable.
    const enc = new TextEncoder();
    let text = caption ?? '';
    const facets = [];
    for (const t of tags) {
      const tag = t.replace(/\W+/g, '');
      if (!tag) continue;
      text += (text ? ' ' : '');
      const start = enc.encode(text).length;
      text += `#${tag}`;
      facets.push({
        index: { byteStart: start, byteEnd: start + enc.encode('#' + tag).length },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
      });
    }
    const rec = await this.#xrpc('com.atproto.repo.createRecord', {
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text, facets,
        createdAt: new Date().toISOString(),
        embed: { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: altText ?? '' }] },
      },
    }, { token: session.accessJwt });
    const rkey = rec.uri.split('/').pop();
    return { id: rec.uri, url: `https://bsky.app/profile/${session.handle}/post/${rkey}` };
  }
}
