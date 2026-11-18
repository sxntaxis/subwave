import fs from 'node:fs';
import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import * as settings from '../settings.js';
import { semanticTagIds } from './tag-library/semantic.js';
import type { WalkedSongLocator } from './tag-library/flags.js';

type CatalogRow = WalkedSongLocator & { musicBrainzId?: string | null };

async function main(): Promise<void> {
  const catalogPath = process.env.NAVIDROME_CATALOG_JSON || '/tmp/navidrome-songs.json';
  const rows = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogRow[];
  await settings.load();
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  const songs = new Map(rows.map((row) => [row.id, row]));
  const ids = db.semanticScopeIds();
  console.log(`[semantic-retry] ${ids.length} tracks selected from the catalog export`);
  const stats = await semanticTagIds(ids, songs, { legacyProviderCap: false });
  console.log(JSON.stringify(stats));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
