/**
 * Local CLIP embedder (text and images share one vector space, so "dog on a beach"
 * can be matched against photo vectors). Runs on-device via @huggingface/transformers:
 * no API key, photos never leave the machine. First use downloads the model (~150 MB
 * for the default) from huggingface.co and caches it.
 *
 * An Embedder is { model, embedText(str) -> Float32Array, embedImage(Buffer) -> Float32Array },
 * returning L2-normalised vectors. Swap in any provider by implementing those two methods.
 */
export class ClipEmbedder {
  constructor({ model = 'Xenova/clip-vit-base-patch32' } = {}) {
    this.model = model;
    this._ready = null;
  }

  #load() {
    this._ready ??= (async () => {
      let t;
      try { t = await import('@huggingface/transformers'); }
      catch { throw new Error('Image search needs the optional dependency: npm install @huggingface/transformers'); }
      const [tokenizer, text, processor, vision] = await Promise.all([
        t.AutoTokenizer.from_pretrained(this.model),
        t.CLIPTextModelWithProjection.from_pretrained(this.model),
        t.AutoProcessor.from_pretrained(this.model),
        t.CLIPVisionModelWithProjection.from_pretrained(this.model),
      ]);
      return { t, tokenizer, text, processor, vision };
    })();
    this._ready.catch(() => { this._ready = null; }); // allow retry after a failed download
    return this._ready;
  }

  async embedText(str) {
    const { tokenizer, text } = await this.#load();
    const { text_embeds } = await text(tokenizer([str], { padding: true, truncation: true }));
    return normalize(text_embeds.data);
  }

  async embedImage(bytes) {
    const { t, processor, vision } = await this.#load();
    const image = await t.RawImage.fromBlob(new Blob([bytes]));
    const { image_embeds } = await vision(await processor(image));
    return normalize(image_embeds.data);
  }
}

export function normalize(v) {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
