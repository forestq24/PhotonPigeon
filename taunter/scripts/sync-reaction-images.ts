/**
 * Registers the repo's reaction_images folder in a Spacetime database: one catalog row and one
 * bytes row per image, in the bucket named by its folder (winning | losing | neutral).
 * Runs as the database administrator through the logged-in `spacetime` CLI. Safe to rerun:
 * registering an image again replaces the file and keeps whether it is switched on.
 *
 *   npm run images:sync -- <database> [server]     (server defaults to maincloud)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const [database, server = 'maincloud'] = process.argv.slice(2);
if (!database) throw new Error('Usage: npm run images:sync -- <database> [server]');
const root = process.env.REACTION_IMAGES_DIR ?? join(import.meta.dirname, '..', '..', 'reaction_images');
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };

let count = 0;
for (const bucket of ['winning', 'losing', 'neutral']) {
  const dir = join(root, `${bucket}_reaction_imgs`);
  for (const fileName of readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const mime = MIME[extname(fileName).toLowerCase()];
    if (!mime) continue;
    const data = readFileSync(join(dir, fileName));
    const id = `${bucket}/${basename(fileName, extname(fileName)).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
    const args = [id, bucket, fileName, mime, createHash('sha256').update(data).digest('hex'), data.toString('hex')].map(arg => JSON.stringify(arg));
    execFileSync('spacetime', ['call', database, 'register_reaction_image', ...args, '--server', server], { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`registered ${id} (${data.length} bytes)`);
    count++;
  }
}
console.log(`${count} image(s) registered in ${database}`);
