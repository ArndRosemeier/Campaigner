/**
 * Domain barrel (00-OVERVIEW): every cross-module data shape comes from
 * `/src/domain` — features never define their own copies of entity types.
 */
export * from '@/domain/artifact';
export * from '@/domain/artifactRevision';
export * from '@/domain/battle';
export * from '@/domain/campaign';
export * from '@/domain/create';
export * from '@/domain/deliverable';
export * from '@/domain/embedding';
export * from '@/domain/entity';
export * from '@/domain/entityNormalization';
export * from '@/domain/encounterMap';
export * from '@/domain/gameSystem';
export * from '@/domain/image';
export * from '@/domain/module';
export * from '@/domain/persona';
export * from '@/domain/rulebook';
export * from '@/domain/run';
export * from '@/domain/settings';
export * from '@/domain/statblock';
export * from '@/domain/wikiGraph';
