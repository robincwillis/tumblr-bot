/** config: { instance: "https://mastodon.social", accessToken, visibility?: "public" } */
export class Mastodon {
  static label = 'Mastodon';
  constructor(name, cfg) {
    if (!cfg.instance || !cfg.accessToken) throw new Error(`destination "${name}" (mastodon): "instance" and "accessToken" are required`);
    this.name = name;
    this.base = cfg.instance.replace(/\/$/, '');
    this.token = cfg.accessToken;
    this.visibility = cfg.visibility ?? 'public';
    this.limits = { captionMax: 500 };
  }
  async #api(path, init) {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
    if (!res.ok) throw new Error(`Mastodon ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async post({ asset, bytes, caption, tags, altText }) {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: asset.mime }), asset.name);
    if (altText) form.set('description', altText);
    const media = await this.#api('/api/v2/media', { method: 'POST', body: form });
    const status = [caption, tags.map((t) => '#' + t.replace(/\W+/g, '')).join(' ')].filter(Boolean).join('\n\n');
    const post = await this.#api('/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, media_ids: [media.id], visibility: this.visibility }),
    });
    return { id: post.id, url: post.url };
  }
}
