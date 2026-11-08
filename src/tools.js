import { z } from 'zod';

/**
 * The tool registry — the single definition of what photobot can do.
 * src/mcp.js (agents), src/http.js (REST) and src/cli.js (humans/scripts) are all
 * generated from this list, so a new tool appears in every interface at once.
 *
 * handler(bot, input) -> { data, image? }   image = { bytes: Buffer, mime }
 */
const filters = {
  query: z.string().optional().describe('Words that must all appear in the file path, e.g. "japan temple"'),
  tags: z.array(z.string()).optional().describe('Folder-derived tags that must all match. See list_tags.'),
  folder: z.string().optional().describe('Only photos inside this folder (relative to source root)'),
  source: z.string().optional().describe('Restrict to one source'),
  after: z.string().optional().describe('ISO date; only files modified on/after'),
  before: z.string().optional().describe('ISO date; only files modified on/before'),
  notPostedTo: z.string().optional().describe('Destination name; hide photos already posted there'),
};

export const tools = [
  {
    name: 'describe',
    description: 'Show configured photo sources, posting destinations (with their limits), and what is blocked. Call this first.',
    input: z.object({}),
    handler: async (bot) => ({ data: { ...bot.describe(), blocked: bot.blocked() } }),
  },
  {
    name: 'search_photos',
    description: 'Search the photo collection by path words, folder tags, folder and date. Returns metadata only; use view_photo to actually look at one.',
    input: z.object({
      ...filters,
      sort: z.enum(['name', 'newest', 'oldest', 'random']).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      offset: z.number().int().min(0).optional(),
      refresh: z.boolean().optional().describe('Rescan the sources instead of using the 60s cache'),
    }),
    handler: async (bot, input) => ({ data: await bot.search(input) }),
  },
  {
    name: 'find_photos_by_content',
    description: 'Search by what photos LOOK like, not by file or folder names: text like "sunset over water" or "a dog on a beach", and/or similarTo a photo id (find more like this one). Combine with the usual filters. Scores are CLIP similarity: roughly 0.25-0.35 is a good text match, so use relative ranking, and view_photo the top results to confirm. Needs index_photos to have been run.',
    input: z.object({
      text: z.string().optional().describe('Describe the photo you want'),
      similarTo: z.string().optional().describe('Photo id to find look-alikes of'),
      ...filters,
      limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      minScore: z.number().optional().describe('Drop results below this cosine score'),
    }).refine((v) => v.text || v.similarTo, 'Give text and/or similarTo'),
    handler: async (bot, input) => ({ data: await bot.visualSearch(input) }),
  },
  {
    name: 'index_photos',
    description: 'Build/update the visual search index: embeds photos that are new or changed, in batches. Check `remaining` and call again until it is 0. The first run downloads the model and can take a while for big libraries; later runs only process new photos.',
    input: z.object({ source: z.string().optional(), limit: z.number().int().min(1).max(2000).optional().describe('Photos per call, default 200') }),
    handler: async (bot, input) => ({ data: await bot.indexPhotos(input) }),
  },
  {
    name: 'random_photos',
    description: 'Pick random photos (never blocked ones). Pass notPostedTo to avoid repeats for a destination. Great for "post something from my trips".',
    input: z.object({ ...filters, count: z.number().int().min(1).max(20).optional().describe('Default 1') }),
    handler: async (bot, input) => ({ data: await bot.random(input) }),
  },
  {
    name: 'list_tags',
    description: 'List the folder-derived tags in the collection with photo counts — a quick map of what is in there.',
    input: z.object({ source: z.string().optional() }),
    handler: async (bot, input) => ({ data: await bot.tags(input) }),
  },
  {
    name: 'view_photo',
    description: 'Fetch a photo by id so you can look at it (to judge quality, write a caption or alt text). Images over 4 MB return metadata only.',
    input: z.object({ id: z.string() }),
    handler: async (bot, { id }) => {
      const { asset, bytes } = await bot.read(id);
      const tooBig = bytes.length > 4 * 1024 * 1024;
      return { data: { ...asset, note: tooBig ? 'too large to preview (>4MB); metadata only' : undefined }, image: tooBig ? undefined : { bytes, mime: asset.mime } };
    },
  },
  {
    name: 'post_photo',
    description: 'Post a photo to one or more destinations. Tags default to the photo\'s folder tags. Refuses blocked photos, repeats and over-limit files unless force. Use dryRun to preview. Posting is public and irreversible from here — confirm with the user unless they already asked you to post.',
    input: z.object({
      id: z.string().describe('Photo id from search_photos / random_photos'),
      destinations: z.array(z.string()).min(1).describe('Destination names from describe'),
      caption: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Overrides folder tags'),
      altText: z.string().optional().describe('Accessibility description of the image'),
      dryRun: z.boolean().optional().describe('Validate and show what would be posted without posting'),
      force: z.boolean().optional().describe('Repost / bypass block. Only if the user explicitly asks.'),
    }),
    handler: async (bot, input) => ({ data: await bot.post(input) }),
  },
  {
    name: 'post_history',
    description: 'Recent posts, newest first.',
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    handler: async (bot, { limit }) => ({ data: bot.history(limit) }),
  },
  {
    name: 'block',
    description: 'Never pick or post a folder (and everything under it) or a single photo again.',
    input: z.object({ folder: z.string().optional(), photo: z.string().optional().describe('Photo id') }).refine((v) => v.folder || v.photo, 'Give folder or photo'),
    handler: async (bot, input) => ({ data: bot.block(input) }),
  },
  {
    name: 'unblock',
    description: 'Remove a folder or photo from the block list.',
    input: z.object({ folder: z.string().optional(), photo: z.string().optional() }).refine((v) => v.folder || v.photo, 'Give folder or photo'),
    handler: async (bot, input) => ({ data: bot.unblock(input) }),
  },
];

export const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));
