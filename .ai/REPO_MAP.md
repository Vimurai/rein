# REPO_MAP.md — AST Repository Map (auto-generated)
<!-- ast-parser-mcp generate_map (E-97): 27/153 files, budget 2048 tokens. `⋮` = elided function body. -->

## src/mcp/shared/record-store.mjs  (centrality 1)
exports: PROJECT_SCHEMA, PROJECT_KEYS, isRecordStore, gitEmail, headSha, recordPath, readRecord, CLAIM_KEYS, assertTaskRecord, writeRecord, listRecords, taskRecord, stampRecord, stampRecordId, nextSeq, insertTask, updateTask, insertStamp, setProject, archiveRecords, orderRecords, rebuildIndex, writeStateFile, renderStateJson, renderViews
imports: fs, path, child_process, ./state-db.js, ./legacy-import.mjs, ../../shared/publish-scan.mjs

## src/shared/publish-scan.mjs  (centrality 0.9617)
exports: CLASSES, ALLOWABLE_FILES, EXEMPT_FILES, isExported, exportFiles, loadScanConfig, checkAllow, scanText, scanFiles, treeProblems, identityProblem, doctorLine, REDACT_WRITERS, redactLists, redactedToday, redact
imports: node:child_process, node:fs, node:os, node:path, ../mcp/shared/is-main.mjs, ../mcp/safe-exec-mcp/secret-rule.mjs

## src/mcp/shared/is-main.mjs  (centrality 0.9243)
exports: isMainModule
imports: node:fs, node:url

## src/mcp/shared/state-db.js  (centrality 0.5617)
exports: getDb, getDbSeeded, openIndexIfExists, importStateJson, parseDeps, readState, roleFromOwner, archivePointerLines, regenerateViews, MAX_DAG_DEPTH, readDependencyGraph, validateDag, withTransaction, nextId, recordIdHighWater, addTask, completeTask, stampProvisioning, DONE_ARCHIVE_THRESHOLD, DONE_KEEP_RECENT, STAMP_ARCHIVE_THRESHOLD, STAMP_KEEP_RECENT, archiveDoneTasks, archiveStamps, nextTopicSeedId, nextClusterPageId
imports: fs, path, node:sqlite, ./ci-runs.js, ./record-store.mjs, ./team.mjs, ./legacy-import.mjs

## src/mcp/shared/team.mjs  (centrality 0.5222)
exports: TEAM_SCHEMA, TeamError, isBranchName, readTeam, validateTeam, writeTeam, newTeam, addRange, isPlanner, nextTeamId, describeTeam, logPath, appendLog, recentLog
imports: child_process, os, fs, path, ./record-store.mjs, ../../shared/publish-scan.mjs
class TeamError
  constructor(code, message) ⋮

## src/mcp/shared/legacy-import.mjs  (centrality 0.4739)
exports: BLOB_MIRROR, StateBehindHeadError, headBlob, checkBehindHead, assertNotBehindHead, importLegacy, stateHealth
imports: fs, path, child_process, ./record-store.mjs
class StateBehindHeadError
  constructor(line) ⋮

## src/mcp/safe-exec-mcp/secret-rule.mjs  (centrality 0.468)
exports: SCAN_LIMIT, isReference, containsSecret

## src/shared/telemetry.mjs  (centrality 0.3667)
exports: TELEMETRY_SERVICE, LIVE_TELEMETRY_DB_PATH, resolveTelemetryDbPath, TELEMETRY_DB_PATH, STATUS_ORDER, STATUS_VALUES, STATUS_SQL_IN, STATUS_MIGRATION_SENTINEL, SOURCE_ORDER, SOURCE_VALUES, SOURCE_SQL_CHECK, VELOCITY_EXTRA_COLUMNS, canonicalToolName, downTaskVelocityColumns, recordToolExecution, recordTaskVelocity, getTelemetryStats, resetTelemetryStore, resetTelemetryCache
imports: node:sqlite, node:crypto, node:fs, node:path, node:os, node:url

## tests/lib/check-table.mjs  (centrality 0.3592)
exports: repo, gateInProcess, loadTable, commandOf, analyse, tableTests
imports: node:test, node:assert/strict, node:fs, node:os, node:path, node:url

## src/shared/mcp-telemetry.mjs  (centrality 0.3264)
exports: TELEMETRY_STATUS, toolNameFor, EXPECTED_REJECTION_META, BOOTED_BUILD_META, stampBootedBuild, statusForResult, rejection, markRejection, withTelemetry, instrument
imports: ./telemetry.mjs, ./build-stamp.mjs

## src/shared/locate.mjs  (centrality 0.2602)
exports: enableDevTree, _resetDevTree, isFrameworkClone, locate
imports: node:fs, node:child_process, node:path, ../mcp/shared/is-main.mjs

## src/shared/build-stamp.mjs  (centrality 0.2413)
exports: RUN_DIR, buildStampEnabled, recordPathFor, buildInputsFor, stampFor, bootedBuild, isStdioServerInvocation, _resetBootedBuild, writeBootRecord, listStaleServers, GATED_ROOTS, mirrorDrift, checkCompletionBuildGate, formatStaleLines, staleServerReport
imports: node:crypto, node:fs, node:os, node:path, node:url, ./locate.mjs

## src/mcp/shared/logger.js  (centrality 0.2352)
exports: createLogger

## src/mcp/shared/ci-runs.js  (centrality 0.2181)
exports: CI_STATUSES, CI_LOG_KEEP_RUNS, CI_LOG_KEEP_DAYS, CI_RUNS_UP, CI_RUNS_DOWN, CI_RESOURCE_COLUMNS, migrateCiRuns, downCiRuns, recordCiRun, latestCiRun, listCiRuns, ciRunCount, ciVerdict, ageOf, shortLine, parseCiLog, recordCiRunFromLog, failedSections, pruneCiLogs, getCiStatus, certifyingRunFor, certifiedBy, ciAdopted, checkCiDoneGate, recordCiSkip
imports: fs, path, child_process, ./ci-evidence.mjs, ./ci-budget.js

## src/mcp/shared/ci-evidence.mjs  (centrality 0.2008)
exports: CI_RECORD_SCHEMA, CI_VERDICTS, ciRecordPath, validateCiRecord, readCiRecord, listCiRecords, hasCiRecords, mergeCiRecords, preferRecord, ciRecordFromRow, writeCiRecord
imports: fs, path, os, ./team.mjs, ./record-store.mjs, ../../shared/publish-scan.mjs

## src/mcp/safe-exec-mcp/architect-writes.mjs  (centrality 0.1987)
exports: isSafeArchitectPath, boundedRel, hardlinkAlias, projectPathVerdict, architectPathVerdict, findProjectRootFrom, analyzeArchitectWrites
imports: shell-quote, node:fs, node:path

## src/shared/instinct-stager.mjs  (centrality 0.1919)
exports: MIN_CONFIDENCE, isSafeSlug, scanDangerousContent, slugify, validateInstinct, renderProposedSkill, stageInstincts
imports: node:fs, node:path, ./publish-scan.mjs

## src/shared/provider-adapter.mjs  (centrality 0.1756)
exports: DEFAULT_ROLE_PROVIDERS, DEFAULT_ROLE_MODELS, DEFAULT_HEADLESS_ROLES, DEFAULT_ADAPTERS, roleEntry, roleProvider, roleModel, isHeadless, roleLabel, providerAdapter, buildArgv, PATH_OPERAND_FLAGS, absolutisePathOperands, childEnv
imports: node:fs, node:path

## src/mcp/shared/ci-budget.js  (centrality 0.1672)
exports: BUDGET_FIELDS, RATCHET, parseBudgetLine, budgetBest, budgetLimit, budgetCheck, regressionLine, budgetSet, DRIFT_FIELDS, DRIFT_PCT, budgetDrift, driftLine, budgetSummary

## src/shared/markdown-exec.mjs  (centrality 0.1551)
exports: EXECUTABLE_FENCE_TAGS, isSkillOrAgentFile, isProseOnlyFile, isGeneratedRecord, isInertInputTable, classifyMarkdown, addedLines

## src/mcp/shared/trunk.mjs  (centrality 0.1537)
exports: originHead, resolveTrunk, discoverTrunk, trunkDoctor
imports: child_process, path, ./team.mjs

## src/shared/hosted-ci.mjs  (centrality 0.1252)
exports: DEFAULT_AIOS_SOURCE, SELF_BOOTSTRAP, REQUIRED_CHECK, PROVIDERS, trunkFor, policyFor, remoteHost, detectProvider, isAiOsRepo, pinnedVersion, bootstrapFor, HostedCiError, render, renderable, sha256, hosted, doctorLine
imports: node:fs, node:crypto, node:child_process, node:path, node:url, ../mcp/shared/is-main.mjs, ../mcp/shared/team.mjs, ../mcp/shared/trunk.mjs, ./publish-scan.mjs
class HostedCiError
  constructor(code, message) ⋮

## src/shared/legacy-registry.mjs  (centrality 0.1252)
exports: KINDS, CLASSES, RULES, registryPath, loadRegistry, sha256File, expandEntryPaths, scanProcesses, scanSettingAllows, scan, summarize
imports: node:crypto, node:fs, node:child_process, node:os, node:path

## src/shared/standards-checker.mjs  (centrality 0.1252)
exports: DEFAULT_STANDARDS_PATH, SEVERITY_ORDER, loadStandards, RULE_REGISTRY, suppressionTokensFor, knownSuppressionTokens, isSuppressed, unknownSuppressionFindings, exemptionFor, validateFile, validateStaged, validateFiles, reportDrift, validateStandards
imports: node:fs, node:path, node:child_process, ./markdown-exec.mjs, ./standards-test-rules.mjs

## src/shared/standards-test-rules.mjs  (centrality 0.1083)
exports: TEST_RULES

## src/shared/ci-summary.mjs  (centrality 0.1018)
exports: parseSummary, sectionAfter
imports: node:fs, node:url

## tests/tools/census.mjs  (centrality 0.1018)
exports: MERGE_OVERLAP, MISNAMED_RE, LABEL_RE, inventory, staticFacts, resolveTarget, spawnShape, parseCensusLines, installerLane, parseCiLogForCensus, failureHistory, overlap, HUB_SHARE, hubFiles, deriveCandidates, buildCensus, renderMarkdown, main
imports: node:fs, node:path, node:os, node:child_process, node:url
