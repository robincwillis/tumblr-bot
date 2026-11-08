#!/usr/bin/env node
import http from 'node:http';
import { z } from 'zod';
import { createBot } from './context.js';
import { tools, toolByName } from './tools.js';

/**
 * REST interface:
 *   GET  /tools            tool list with JSON Schemas
 *   GET  /openapi.json     OpenAPI 3 document (for GPT actions, n8n, Zapier, ...)
 *   POST /tools/:name      JSON body = tool input  ->  { data, image? }
 *   GET  /media/:id        photo bytes (Bearer key, or ?sig= signed link)
 * Auth: set PHOTOBOT_API_KEY (or config.http.apiKey) and send "Authorization: Bearer <key>".
 */
export function createHttpServer({ bot, config, verifySig }) {
  const apiKey = process.env.PHOTOBOT_API_KEY ?? config.http?.apiKey;
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const authed = (req) => !apiKey || req.headers.authorization === `Bearer ${apiKey}`;
  const schemaOf = (t) => z.toJSONSchema(t.input, { io: 'input' });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');

      if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
        const id = decodeURIComponent(url.pathname.slice(7));
        if (!authed(req) && !verifySig(id, url.searchParams.get('sig'))) return json(res, 401, { error: 'unauthorized' });
        const { asset, bytes } = await bot.read(id);
        res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': bytes.length });
        return res.end(bytes);
      }

      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/tools') {
        return json(res, 200, tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaOf(t) })));
      }
      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        return json(res, 200, {
          openapi: '3.0.3',
          info: { title: 'photobot', version: '1.0.0' },
          paths: Object.fromEntries(tools.map((t) => [`/tools/${t.name}`, {
            post: {
              operationId: t.name, summary: t.description,
              requestBody: { required: true, content: { 'application/json': { schema: schemaOf(t) } } },
              responses: { 200: { description: 'Tool result' } },
            },
          }])),
          components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
          security: apiKey ? [{ bearer: [] }] : [],
        });
      }

      const m = url.pathname.match(/^\/tools\/([\w-]+)$/);
      if (req.method === 'POST' && m) {
        const tool = toolByName[m[1]];
        if (!tool) return json(res, 404, { error: `unknown tool ${m[1]}` });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const parsed = tool.input.safeParse(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        if (!parsed.success) return json(res, 400, { error: 'invalid input', issues: parsed.error.issues });
        const { data, image } = await tool.handler(bot, parsed.data);
        return json(res, 200, { data, ...(image && { image: { mime: image.mime, base64: image.bytes.toString('base64') } }) });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const ctx = createBot();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(process.env.PHOTOBOT_API_KEY ?? ctx.config.http?.apiKey)) {
    console.error('Refusing to listen on a non-loopback address without PHOTOBOT_API_KEY set.');
    process.exit(1);
  }
  createHttpServer(ctx).listen(port, host, () => console.log(`photobot HTTP API on http://${host}:${port}`));
}
