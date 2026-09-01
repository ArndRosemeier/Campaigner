/**
 * DB barrel: the only place components/features import database access from.
 * Components never import `dexie` or reach into `db.*` tables directly
 * (00-OVERVIEW, 01-DATA-MODEL §Repository layer).
 */
export { db, CampaignerDB } from '@/db/db';
export * as campaignRepo from '@/db/campaignRepo';
export * as artifactRepo from '@/db/artifactRepo';
export * as moduleRepo from '@/db/moduleRepo';
export * as rulebookRepo from '@/db/rulebookRepo';
export * as chunkRepo from '@/db/chunkRepo';
export * as embeddingRepo from '@/db/embeddingRepo';
export * as personaRepo from '@/db/personaRepo';
export * as runRepo from '@/db/runRepo';
export * as settingsRepo from '@/db/settingsRepo';
