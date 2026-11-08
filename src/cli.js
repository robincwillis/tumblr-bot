#!/usr/bin/env node
import fs from 'node:fs';
import { z } from 'zod';
import { createBot } from './context.js';
import { tools, toolByName } from './tools.js';

const usage = () => `photobot <tool> [--flag value ...]   (or: photobot <tool> '{"json":"input"}')

Tools:
${tools.map((t) => `  ${t.name.padEnd(14)} ${t.description.split('. ')[0]}`).join('\n')}

Flags map to the tool's inputs. Arrays are comma-separated (--tags japan,temple),
booleans are bare (--dryRun). Output is JSON. For view_photo, --out FILE saves the image.
Run 'photobot help <tool>' for a tool's inputs.`;

function coerce(tool, argv) {
  if (argv[0]?.startsWith('{')) return JSON.parse(argv[0]);
  const props = z.toJSONSchema(tool.input, { io: 'input' }).properties ?? {};
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'out') { i++; continue; }
    const type = props[key]?.type;
    if (!type) throw new Error(`Unknown flag --${key} for ${tool.name}`);
    if (type === 'boolean') out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${key} needs a value`);
      out[key] = type === 'array' ? v.split(',') : type === 'integer' || type === 'number' ? Number(v) : v;
    }
  }
  return out;
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === 'help' && !rest[0]) { console.log(usage()); process.exit(name ? 0 : 1); }
if (name === 'help') {
  const t = toolByName[rest[0]];
  if (!t) { console.error(`Unknown tool ${rest[0]}`); process.exit(1); }
  console.log(`${t.description}\n\n${JSON.stringify(z.toJSONSchema(t.input, { io: 'input' }).properties, null, 2)}`);
  process.exit(0);
}
const tool = toolByName[name];
if (!tool) { console.error(`Unknown tool "${name}"\n\n${usage()}`); process.exit(1); }

try {
  const input = tool.input.parse(coerce(tool, rest));
  const { bot } = createBot();
  const { data, image } = await tool.handler(bot, input);
  const outIdx = rest.indexOf('--out');
  if (image && outIdx >= 0) fs.writeFileSync(rest[outIdx + 1], image.bytes);
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.error(e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : e.message);
  process.exit(1);
}
