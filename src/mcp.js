#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBot } from './context.js';
import { tools } from './tools.js';

// stdout is the protocol channel: never console.log here, use stderr.
const { bot } = createBot();
const server = new McpServer({ name: 'photobot', version: '1.0.0' });

for (const t of tools) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.input.shape }, async (args) => {
    try {
      const parsed = t.input.parse(args);
      const { data, image } = await t.handler(bot, parsed);
      const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
      if (image) content.push({ type: 'image', data: image.bytes.toString('base64'), mimeType: image.mime });
      return { content };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error('photobot MCP server ready');
