export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
/*
 * Image attachments: the server names the uploaded file (so it needs the MIME helpers), and
 * anything that wants to know what will actually be sent can reuse the same reader.
 */
export {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  formatMb,
  guessImageMime,
  normalizeImageMime,
  resolveImageMime,
  resolveImages,
  skippedNotice,
} from './providers/images.js';
export type { ResolvedImage, ResolvedImages } from './providers/images.js';
export {
  classifyLlmFailure,
  failureLabel,
  retryStatusText,
  LENGTH_NOTICE_TEXT,
  StreamInterruptedError,
  type LlmFailureKind,
} from './providers/stream-failure.js';
export { Agent, TurnInProgressError } from './agent.js';
export { getSystemPrompt } from './system-prompt.js';
export { createKBTools } from './kb-tools.js';
export { readSkillProfile, writeSkillProfile, type SkillProfile } from './system-prompt.js';
export { PlanStore, renderPlan, createPlanTools, nextStepOf, planSessions, adoptSessionPlansIntoWorkspace } from './plan-tools.js';
export type { Plan, PlanStep, StepStatus, StepFailurePolicy, StepInput, StepUpdate, PlanSessionSummary } from './plan-tools.js';
export {
  analyzeRequest,
  buildRecord,
  renderRecord,
  PreflightStore,
  createPreflightTools,
} from './preflight.js';
export type {
  PreflightRecord,
  PreflightEvidence,
  PreflightContext,
  PreflightInput,
  Prerequisite,
  PrerequisiteKind,
  Constraint,
  ConstraintSource,
} from './preflight.js';
export {
  classifyToolResult,
  annotateToolResult,
  isToolFailure,
} from './tool-result.js';
export type { ToolFailureKind, ToolResultVerdict } from './tool-result.js';
export { DEFAULT_BUDGET, budgetStop, parseBudgetLimits, renderBudgetStop } from './budget.js';
export type { BudgetKind, BudgetLimits, BudgetStop, BudgetUsage } from './budget.js';
/*
 * 动态上下文 / 成本分配。
 *
 * `context-budget.ts` 里没有一行读时钟、文件或环境变量 —— 它的输出只取决于（定价, 用量, 档位），
 * 所以"按定价选策略"这件事能在没有模型、没有网络的情况下被测，也能被 `pnpm check:context` 那样
 * 的脚本直接调。
 */
export {
  allocateContext,
  estimateCost,
  pricingConfigured,
  pricingNote,
  parseContextBudget,
  DEFAULT_PRICING,
  DEFAULT_CONTEXT_BUDGET,
  COST_DISCLAIMER,
} from './context-budget.js';
export type {
  Allocation,
  CompressionChoice,
  CompressionLevel,
  ContextBudgetConfig,
  CostBreakdown,
  Lever,
  LeverId,
  TokenPricing,
  UsageLike,
} from './context-budget.js';
export {
  MAX_PARALLEL_READS,
  READ_ONLY_TOOLS,
  inWaves,
  isReadOnlyTool,
  queryKey,
  readsToPrefetch,
  stableStringify,
} from './read-batch.js';
export { RunTraceStore, RunRecorder, distinctTokens } from './run-trace.js';
export type { RunEvent, RunEventKind, RunState, RunSummary, RunReadResult, RunTraceOptions } from './run-trace.js';
export {
  ErrorBook,
  createErrorbookTools,
  isWorthRemembering,
  renderErrorbook,
  formatErrorEntry,
  ERRORBOOK_ROOT,
} from './errorbook.js';
export type { ErrorbookKind, ErrorEntry, FailureReport, ErrorbookEngineLike, ReflectionReport } from './errorbook.js';
export { retireKnownFalsePositives, matchKnownFalsePositive, migrationsMarkerPath, KNOWN_FALSE_POSITIVES, FALSE_POSITIVE_REGISTRY_VERSION } from './errorbook-migrations.js';
export type { KnownFalsePositive, RetireKnownFalsePositivesResult } from './errorbook-migrations.js';
export {
  ConfidenceMirror,
  detectDrift,
  deriveReflections,
  createReflectionTools,
  renderCalibration,
  renderDrift,
  renderReflection,
  goalTerms,
  prohibitionObject,
  REFLECTION_DIR,
  CONFIDENCE_SCHEMA,
} from './reflection.js';
export type {
  DriftAction,
  DriftInput,
  DriftLevel,
  DriftReport,
  DriftSignal,
  DriftSignalKind,
  CalibrationReport,
  CalibrationBucket,
  ConfidenceSample,
  ReflectionNote,
  ReflectionSources,
  ReflectionToolDeps,
  ReflectionToolSet,
} from './reflection.js';
export { reviewClaims, renderCriticReview, extractClaims, actionableFindings } from './critic.js';
export type { CriticClaim, CriticFinding, CriticReview, CriticStatus, CriticVerdict } from './critic.js';
export {
  guardrailEnabled,
  guardrailPolicy,
  highFindings,
  redactForRecord,
  renderGuardrailNotice,
  renderGuardrailRefusal,
  scanOutbound,
  summariseFindings,
} from './guardrail.js';
export type {
  GuardrailFinding,
  GuardrailKind,
  GuardrailPolicy,
  GuardrailSeverity,
} from './guardrail.js';
export { createIngestTools, chunkFileContent } from './ingest-tools.js';
export type { IngestItem, IngestBatch } from './ingest-tools.js';
export { MemoStore, createMemoTools, adoptSessionMemosIntoWorkspace } from './memo-tools.js';
export type { MemoEntry } from './memo-tools.js';

/*
 * 会话状态目录：跨会话隔离的唯一路径解析点。见 session-state.ts 里的说明 —— 放在 barrel 上是为了
 * 让"拼会话路径"这件事只有一个入口，谁也别自己 join。
 */
export {
  sessionStateDir,
  sessionStateRelDir,
  sessionsRoot,
  SESSIONS_REL,
  STATE_REL,
  WORKSPACE_SCOPE,
  isWorkspaceScope,
  workspaceStateFile,
  CHAT_SESSION_PREFIX,
  decodeSessionId,
  listSessionIds,
  isSafeSessionId,
  encodeSessionId,
  assertSessionId,
} from './session-state.js';
export {
  createSubagentTools,
  composeHandoffPrompt,
  shouldIsolate,
  readChildProgress,
  formatTimeoutReport,
  resolveSubagentTimeoutMs,
  subagentWrapUpDelayMs,
  subagentWrapUpScheduleMs,
  composeWrapUpNudge,
  armSubagentWrapUp,
  SUBAGENT_WRAP_UP_RATIO,
  SUBAGENT_WRAP_UP_RATIOS,
  selectHarvestNotes,
  renderKbHarvest,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  MIN_SUBAGENT_TIMEOUT_SECONDS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
  HARVEST_INLINE_MAX,
} from './subagent-tools.js';
export type {
  SubagentRunner,
  SubagentRequest,
  SubagentResult,
  SubagentHandoff,
  SubagentWorktree,
  SubagentRunHooks,
  SubagentProgressEvent,
  ChildProgress,
  HarvestNote,
  HarvestCandidate,
  SubagentKbHarvest,
} from './subagent-tools.js';
export { makeScheduleTools, executeScheduleTool } from './schedule-tools.js';
export type { ScheduleBridge, ScheduledTaskView, WindowView } from './schedule-tools.js';
