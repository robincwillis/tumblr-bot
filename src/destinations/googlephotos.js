/**
 * Google Photos Library API, upload-only. Since 2025 the API can only add to / read
 * items the app itself created, so this is a destination, not a source.
 * Needs scope https://www.googleapis.com/auth/photoslibrary.appendonly.
 *
 * config: { clientId, clientSecret, refreshToken, albumId? }
 */
export class GooglePhotos {
  static label = 'Google Photos';
  constructor(name, cfg) {
    for (const k of ['clientId', 'clientSecret', 'refreshToken']) {
      if (!cfg[k]) throw new Error(`destination "${name}" (googlephotos): "${k}" is required`);
    }
    this.name = name;
    this.cfg = cfg;
    this.limits = {};
  }
  async #accessToken() {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
  }
  async post({ asset, bytes, caption, altText }) {
    const token = await this.#accessToken();
    const up = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': asset.mime, 'X-Goog-Upload-Protocol': 'raw',
      },
      body: bytes,
    });
    if (!up.ok) throw new Error(`Google Photos upload: ${up.status} ${await up.text()}`);
    const uploadToken = await up.text();
    const res = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(this.cfg.albumId && { albumId: this.cfg.albumId }),
        newMediaItems: [{ description: caption ?? altText ?? '', simpleMediaItem: { uploadToken, fileName: asset.name } }],
      }),
    });
    const json = await res.json();
    const item = json.newMediaItemResults?.[0];
    if (!res.ok || item?.status?.message !== 'Success') throw new Error(`Google Photos batchCreate: ${JSON.stringify(json)}`);
    return { id: item.mediaItem.id, url: item.mediaItem.productUrl };
  }
}
