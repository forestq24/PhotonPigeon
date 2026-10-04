/**
 * Resolves an approved image id from the database catalog to verified bytes. The id is only a
 * key: the file read is the catalog's own bucket and file name under the local images folder,
 * and the bytes must match the catalog's SHA-256. If the local file is missing or different,
 * the stored copy is fetched from the database and held to the same check.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageResolver } from './delivery-worker.ts';
import type { DbConnection } from './module_bindings/index';

export const defaultImagesDir = (): string => process.env.REACTION_IMAGES_DIR ?? join(import.meta.dirname, '..', '..', 'reaction_images');

export function imageResolver(connection: DbConnection, dir = defaultImagesDir()): ImageResolver {
  return async imageId => {
    const entry = connection.db.reactionImages.id.find(imageId);
    if (!entry?.enabled || !/^(winning|losing|neutral)$/.test(entry.bucket) || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.fileName)) return undefined;
    const matches = (data: Uint8Array) => createHash('sha256').update(data).digest('hex') === entry.sha256;
    const local = await readFile(join(dir, `${entry.bucket}_reaction_imgs`, entry.fileName)).catch(() => undefined);
    if (local && matches(local)) return { data: local, mime: entry.mime, name: entry.fileName };
    const stored = await connection.procedures.fetchReactionImage({ id: imageId }).catch(() => undefined);
    return stored && matches(stored) ? { data: stored, mime: entry.mime, name: entry.fileName } : undefined;
  };
}
