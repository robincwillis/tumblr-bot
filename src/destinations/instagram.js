/**
 * Instagram Graph API (Business/Creator account). Instagram does NOT accept uploads:
 * it fetches the image from a public HTTPS URL, so photobot's HTTP server (or any
 * static host) must be reachable from the internet. Set "publicBaseUrl" on the
 * http interface (e.g. an ngrok / Cloudflare tunnel URL). JPEG only.
 *
 * config: { igUserId, accessToken, apiVersion?: "v21.0" }
 */
export class Instagram {
  static label = 'Instagram';
  constructor(name, cfg, ctx) {
    if (!cfg.igUserId || !cfg.accessToken) throw new Error(`destination "${name}" (instagram): "igUserId" and "accessToken" are required`);
    this.name = name;
    this.ctx = ctx;
    this.id = cfg.igUserId;
    this.token = cfg.accessToken;
    this.api = `https://graph.facebook.com/${cfg.apiVersion ?? 'v21.0'}`;
    this.limits = { mimes: ['image/jpeg'], captionMax: 2200, maxBytes: 8 * 1024 * 1024 };
  }
  async #call(path, params) {
    const res = await fetch(`${this.api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, access_token: this.token }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Instagram ${path}: ${JSON.stringify(json.error ?? json)}`);
    return json;
  }
  async post({ asset, caption, tags }) {
    if (!this.ctx.publicUrlFor) throw new Error('Instagram needs a public image URL: run the HTTP interface with "publicBaseUrl" set');
    const text = [caption, tags.map((t) => '#' + t.replace(/\W+/g, '')).join(' ')].filter(Boolean).join('\n\n');
    const container = await this.#call(`/${this.id}/media`, { image_url: this.ctx.publicUrlFor(asset), caption: text });
    const published = await this.#call(`/${this.id}/media_publish`, { creation_id: container.id });
    return { id: published.id, url: undefined };
  }
}
