/**
 * Hybrid retrieval module (03-RETRIEVAL.md). Public API used by the rules
 * browser and the persona engine.
 */
export { searchRules, type SearchHit, type SearchOptions } from '@/search/search';
export { invalidateKeywordIndex, searchKeyword, type KeywordHit } from '@/search/keywordIndex';
export {
  embeddingsActive,
  ensureEmbeddings,
  embedQuery,
  cosineSimilarity,
  embeddingKey,
  tryEmbeddings,
  resetEmbeddingFailureNotice,
} from '@/search/embeddings';
