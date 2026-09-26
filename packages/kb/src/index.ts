export { KBStore } from './store.js';
export type { CreateGroupInput, CreateMemoryInput, CreateEdgeInput } from './store.js';
export {
  GroupKBEngine, KB_RETIRED_KEY, KB_HISTORY_KEY, KB_VERSION_KEY, KB_HISTORY_MAX,
  isSplitPartOf, resolveLogicalGroup, nextSplitPartIndex, collapseGroupNameChain,
} from './engine.js';
export type { KBRetirement, KBRevision, KBMemoryPatch, KBReviseResult, SplitPartGroupLike } from './engine.js';
export { mergeKnowledgeBases } from './merge.js';
export type { MergeKbResult } from './merge.js';
