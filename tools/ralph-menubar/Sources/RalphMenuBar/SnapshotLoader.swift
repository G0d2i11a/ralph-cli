import AppKit
import Foundation

private let preferredRalphBinaryPaths = [
  "/opt/homebrew/bin/ralph",
  "/usr/local/bin/ralph",
]

private let preferredRalphNodePaths = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/env",
]

private final class PipeCapture {
  var data = Data()
}

private func startPipeCapture(_ pipe: Pipe, label: String) -> (PipeCapture, DispatchGroup) {
  let capture = PipeCapture()
  let group = DispatchGroup()
  let queue = DispatchQueue(label: "ralph.menubar.\(label)", qos: .userInitiated)
  group.enter()
  queue.async {
    capture.data = pipe.fileHandleForReading.readDataToEndOfFile()
    group.leave()
  }
  return (capture, group)
}

func expandPath(_ path: String) -> String {
  NSString(string: path).expandingTildeInPath
}

func abbreviatedPath(_ path: String) -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  if path.hasPrefix(home) {
    return "~" + path.dropFirst(home.count)
  }
  return path
}

func shortRepoName(_ path: String?) -> String {
  guard let path, !path.isEmpty else { return "unknown-repo" }
  return URL(fileURLWithPath: path).lastPathComponent
}

func pathStem(_ path: String?) -> String? {
  guard let path, !path.isEmpty else { return nil }
  let url = URL(fileURLWithPath: path)
  let stem = url.deletingPathExtension().lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
  return stem.isEmpty ? nil : stem
}

func isGenericPrdTitle(_ title: String?) -> Bool {
  guard let title else { return true }
  let normalized = title
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  return normalized.isEmpty || normalized == "untitled prd" || normalized == "untitled"
}

func shortTitle(_ task: TaskState) -> String {
  let title = isGenericPrdTitle(task.prdTitle)
    ? (task.prdId ?? pathStem(task.prdPath) ?? task.id)
    : (task.prdTitle ?? task.prdId ?? pathStem(task.prdPath) ?? task.id)
  return title.count > 78 ? String(title.prefix(75)) + "..." : title
}

func storyCounts(_ task: TaskState) -> (completed: Int, total: Int) {
  (task.completedUSCount ?? task.completedUS?.count ?? 0, task.storyProgress?.count ?? 0)
}

func storySummary(_ task: TaskState) -> String? {
  let counts = storyCounts(task)
  guard counts.total > 0 else { return nil }
  if task.repairContext?.mode == "finalize", let currentUS = task.currentUS, !currentUS.isEmpty {
    return "\(counts.total)/\(counts.total) stories passed · finalizer repair on \(currentUS)"
  }
  if let currentUS = task.currentUS, !currentUS.isEmpty {
    return "\(counts.completed)/\(counts.total) stories passed, now \(currentUS)"
  }
  return "\(counts.completed)/\(counts.total) stories passed"
}

func prdIdentity(_ task: TaskState) -> String? {
  if let prdId = task.prdId, !prdId.isEmpty {
    return prdId
  }
  return pathStem(task.prdPath)
}

func taskStageSummary(_ task: TaskState) -> String? {
  if let nextAction = trimSingleLine(task.queueState?.nextAction, limit: 140) {
    return nextAction
  }

  if let mergeSummary = mergeRepairSummary(task) {
    return mergeSummary
  }

  if isWaitingForRecoveryBlocker(task) {
    if let nextAction = trimSingleLine(task.nextAction, limit: 140) {
      return nextAction
    }
    return "Waiting for an overlapping task to finish auto-recovery"
  }

  if let nextAction = trimSingleLine(task.nextAction, limit: 140) {
    return nextAction
  }

  if isAutoRecovering(task) {
    if task.autoRecovery?.reason == "cooldown" {
      return "Waiting for auto-recovery cooldown"
    }
    return "Auto-recovery is running"
  }

  switch task.status {
  case "running":
    if let currentUS = task.currentUS, !currentUS.isEmpty {
      return "Working on \(currentUS)"
    }
    return "Worker is making changes"
  case "pending":
    return "Waiting in queue"
  case "ready_to_finalize":
    return "Ready for finalizer"
  case "finalizing":
    return "Finalizer is validating and integrating"
  case "completed":
    return isIntegratedCompletion(task) ? "Integrated into the project branch" : "Completed"
  case "failed", "failed_finalize", "stagnant":
    return trimSingleLine(task.errorMessage ?? task.mergeError ?? task.queueState?.reason, limit: 140)
  default:
    return nil
  }
}

func shouldShowTaskErrorSnippet(_ task: TaskState) -> Bool {
  if let phase = queuePhase(task) {
    switch phase {
    case "awaiting_approval", "blocked_by_policy", "blocked", "diagnostics":
      return true
    case "running", "finalizing", "queued", "recovering", "completed":
      return false
    default:
      break
    }
  }

  switch task.status {
  case "failed", "failed_finalize", "stagnant":
    return true
  default:
    return isBlockedCompletion(task) || isTargetSyncFailed(task)
  }
}

func taskErrorSnippet(_ task: TaskState, limit: Int = 180) -> String? {
  guard shouldShowTaskErrorSnippet(task) else { return nil }
  return trimSingleLine(task.errorMessage ?? task.mergeError ?? task.queueState?.reason, limit: limit)
}

func storyStatusLabel(_ story: StoryProgress) -> String {
  guard let id = story.id else { return story.status ?? "unknown" }
  guard let status = story.status else { return id }
  return "\(id): \(status.replacingOccurrences(of: "_", with: " "))"
}

func trimSingleLine(_ text: String?, limit: Int = 180) -> String? {
  guard let text else { return nil }
  let normalized = text
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: "\r", with: " ")
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else { return nil }
  if normalized.count <= limit { return normalized }
  return String(normalized.prefix(limit - 3)) + "..."
}

func formattedTimestamp(_ value: TimeInterval?) -> String {
  guard let value else { return "unknown" }
  let formatter = DateFormatter()
  formatter.dateFormat = "MM-dd HH:mm:ss"
  return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
}

func fullFormattedTimestamp(_ value: TimeInterval?) -> String {
  guard let value else { return "unknown" }
  let formatter = DateFormatter()
  formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
  return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
}

func relativeTimestamp(_ value: TimeInterval?, referenceDate: Date = Date()) -> String {
  guard let value else { return "unknown" }
  let formatter = RelativeDateTimeFormatter()
  formatter.unitsStyle = .short
  return formatter.localizedString(for: Date(timeIntervalSince1970: value / 1000), relativeTo: referenceDate)
}

func relativeIsoTimestamp(_ value: String?, referenceDate: Date = Date()) -> String? {
  guard let value else { return nil }
  let formatter = ISO8601DateFormatter()
  guard let date = formatter.date(from: value) else { return nil }
  let relativeFormatter = RelativeDateTimeFormatter()
  relativeFormatter.unitsStyle = .short
  return relativeFormatter.localizedString(for: date, relativeTo: referenceDate)
}

func queuePhase(_ task: TaskState) -> String? {
  task.queueState?.phase
}

func queueDetail(_ task: TaskState) -> String? {
  task.queueState?.detail
}

func isRecoveryPlanningTask(_ task: TaskState) -> Bool {
  guard queuePhase(task) == "recovering" else { return false }
  switch queueDetail(task) {
  case "generating_followup_prd", "splitting_story":
    return true
  default:
    return false
  }
}

func isRecoveryWaitingTask(_ task: TaskState) -> Bool {
  guard queuePhase(task) == "recovering" else { return false }
  switch queueDetail(task) {
  case "blocked_by_coordination", "blocked_by_dependency":
    return true
  default:
    return false
  }
}

func isQueueActionTask(_ task: TaskState) -> Bool {
  let phase = queuePhase(task)
  return phase == "blocked"
    || phase == "awaiting_approval"
    || phase == "blocked_by_policy"
    || phase == "diagnostics"
}

func isIntegratedCompletion(_ task: TaskState) -> Bool {
  task.status == "completed"
    && (task.integrationStatus == nil || task.integrationStatus == "integrated")
    && !isTargetSyncPending(task)
    && !isTargetSyncFailed(task)
}

func isBlockedCompletion(_ task: TaskState) -> Bool {
  task.status == "completed" && task.integrationStatus == "blocked_conflict"
}

func targetSyncStatus(_ task: TaskState) -> String? {
  task.delivery?.targetSyncStatus
}

func isTargetSyncPending(_ task: TaskState) -> Bool {
  targetSyncStatus(task) == "deferred_dirty_checkout"
}

func isTargetSyncFailed(_ task: TaskState) -> Bool {
  targetSyncStatus(task) == "failed"
}

func isDeliveryPending(_ task: TaskState) -> Bool {
  task.status == "completed" && (!isIntegratedCompletion(task) || isTargetSyncPending(task) || isTargetSyncFailed(task))
}

func isAutoRecovering(_ task: TaskState) -> Bool {
  if isRecoveryPlanningTask(task) || isRecoveryWaitingTask(task) {
    return false
  }

  if queuePhase(task) == "recovering" {
    return true
  }

  return task.autoRecovery?.active == true && !isIntegratedCompletion(task)
}

func isWaitingForRecoveryBlocker(_ task: TaskState) -> Bool {
  if isRecoveryWaitingTask(task) {
    return true
  }

  guard task.status == "pending" else { return false }
  if task.recoveringBlockers?.isEmpty == false {
    return true
  }
  let nextAction = task.nextAction?.lowercased() ?? ""
  return nextAction.contains("auto-recovery") || nextAction.contains("recovering")
}

func isQueuedQueueTask(_ task: TaskState) -> Bool {
  if let phase = queuePhase(task) {
    return phase == "queued"
  }
  return task.status == "pending" && !isWaitingForRecoveryBlocker(task)
}

func isExecutingQueueTask(_ task: TaskState) -> Bool {
  if isSupersededBaselineRepairTask(task) {
    return false
  }

  if isWaitingForRecoveryBlocker(task) || isQueuedQueueTask(task) {
    return false
  }

  if let phase = queuePhase(task) {
    return phase == "running" || phase == "finalizing"
  }

  let executingStatuses = Set(["running", "ready_to_finalize", "finalizing"])
  if executingStatuses.contains(task.status) {
    return true
  }

  return isAutoRecovering(task) || isDeliveryPending(task)
}

func isSupersededBaselineRepairTask(_ task: TaskState) -> Bool {
  let nextAction = task.nextAction?.lowercased() ?? ""
  let stopReason = task.autoRecovery?.stopReason?.lowercased() ?? ""
  let lastReason = task.autoRecovery?.lastReason?.lowercased() ?? ""
  return nextAction.contains("superseded by canonical baseline repair task")
    || nextAction.contains("obsolete baseline repair was superseded")
    || stopReason == "baseline_repair_superseded"
    || lastReason.contains("superseded by canonical baseline repair task")
}

func isMergeRepairTask(_ task: TaskState) -> Bool {
  guard !isIntegratedCompletion(task) else { return false }
  return task.repairContext?.mode == "merge"
    || task.autoRecovery?.kind == "merge_repair"
    || task.mergeRepair != nil
    || task.mergeRepairDisplayStatus != nil
}

func mergeRepairConflictCount(_ task: TaskState) -> Int {
  if let count = task.mergeRepair?.conflictCount {
    return count
  }
  if let count = task.mergeRepair?.conflictFiles?.count {
    return count
  }
  if let count = task.mergeConflict?.files?.count {
    return count
  }
  return task.mergeConflictFiles?.count ?? 0
}

func mergeRepairStoryId(_ task: TaskState) -> String? {
  task.mergeRepair?.storyId ?? task.repairContext?.storyId ?? task.currentUS
}

func mergeRepairIntegrationBranch(_ task: TaskState) -> String? {
  task.mergeRepair?.integrationBranch ?? task.integrationBranch
}

func mergeRepairSummary(_ task: TaskState) -> String? {
  guard isMergeRepairTask(task) else { return nil }

  let story = mergeRepairStoryId(task).map { " on \($0)" } ?? ""
  let conflictCount = mergeRepairConflictCount(task)
  let conflictPart = conflictCount > 0
    ? " · resolving \(conflictCount) conflict\(conflictCount == 1 ? "" : "s")"
    : ""
  let branchPart = mergeRepairIntegrationBranch(task).map { " against \($0)" } ?? ""

  switch task.status {
  case "running":
    return "Merge repair is executing\(story)\(conflictPart)\(branchPart)"
  case "pending":
    return "Waiting to start merge repair\(story)\(conflictPart)\(branchPart)"
  case "ready_to_finalize", "finalizing":
    return "Merge repair passed probe; finalizer is validating\(story)"
  case "failed", "failed_finalize", "stagnant":
    return "Merge repair needs recovery\(story)\(conflictPart)"
  default:
    if task.mergeRepair?.status == "probe_mergeable" || task.mergeRepair?.status == "resolved_pending_finalize" {
      return "Merge repair probe is clean; waiting for finalizer"
    }
    return "Merge repair state is being tracked\(story)\(conflictPart)"
  }
}

func isActiveQueueTask(_ task: TaskState) -> Bool {
  if isSupersededBaselineRepairTask(task) {
    return false
  }

  if let phase = queuePhase(task) {
    return phase == "queued"
      || phase == "running"
      || phase == "finalizing"
      || phase == "recovering"
      || isQueueActionTask(task)
  }

  let activeStatuses = Set(["pending", "running", "ready_to_finalize", "finalizing"])
  if activeStatuses.contains(task.status) {
    return true
  }
  return isAutoRecovering(task) || isDeliveryPending(task)
}

func statusDisplayLabel(_ task: TaskState) -> String {
  if let phase = queuePhase(task) {
    switch phase {
    case "running":
      return "Running"
    case "finalizing":
      if queueDetail(task) == "ready_to_finalize" {
        return "Ready to merge"
      }
      return "Finalizing"
    case "recovering":
      switch queueDetail(task) {
      case "generating_followup_prd":
        return "Planning follow-up"
      case "auto_repairing_merge":
        return "Merge repair"
      case "auto_repairing_story":
        return "Story repair"
      case "auto_repairing_finalize":
        return "Finalize repair"
      case "auto_repairing_baseline", "reclassifying_baseline_failure":
        return "Baseline repair"
      case "auto_repairing_stagnation":
        return "Stagnation repair"
      case "retrying_transient":
        return "Retrying"
      case "retrying_agent_context":
        return "Context retry"
      case "splitting_story":
        return "Splitting story"
      case "diagnosing_failure":
        return "Diagnosing"
      case "blocked_by_coordination", "blocked_by_dependency":
        return "Waiting"
      default:
        return "Repairing"
      }
    case "awaiting_approval":
      return "Approval"
    case "blocked_by_policy":
      return "Policy blocked"
    case "blocked":
      switch queueDetail(task) {
      case "blocked_by_dependency":
        return "Dependency"
      case "blocked_by_baseline":
        return "Baseline"
      case "blocked_by_environment":
        return "Environment"
      case "blocked_by_coordination":
        return "Coordination"
      default:
        return "Blocked"
      }
    case "diagnostics":
      return "Diagnosing"
    case "completed":
      return "Completed"
    case "queued":
      return "Queued"
    default:
      break
    }
  }

  if isMergeRepairTask(task) {
    if task.autoRecovery?.reason == "cooldown" {
      return "Merge cooldown"
    }

    if task.mergeRepair?.status == "probe_mergeable" || task.mergeRepair?.status == "resolved_pending_finalize" {
      return "Merge verified"
    }

    switch task.status {
    case "pending":
      return "Merge queued"
    case "running":
      return "Merge repair"
    case "ready_to_finalize", "finalizing":
      return "Merge verifying"
    case "failed", "failed_finalize", "stagnant":
      return "Merge repair"
    default:
      return "Merge repair"
    }
  }

  if isAutoRecovering(task) {
    if task.autoRecovery?.reason == "cooldown" {
      return "Cooling down"
    }
    return "Repairing"
  }

  if isBlockedCompletion(task) {
    return "Merge blocked"
  }

  if isTargetSyncFailed(task) {
    return "Sync failed"
  }

  if isTargetSyncPending(task) {
    return "Sync pending"
  }

  if isIntegratedCompletion(task) {
    return "Integrated"
  }

  if isWaitingForRecoveryBlocker(task) {
    return "Waiting"
  }

  switch task.status {
  case "pending":
    return "Queued"
  case "running":
    return "Running"
  case "ready_to_finalize":
    return "Ready to merge"
  case "finalizing":
    return "Finalizing"
  case "failed_finalize":
    return "Merge blocked"
  case "stagnant":
    return "Stalled"
  case "failed":
    return "Failed"
  default:
    return task.status.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

func autoRecoverySummary(_ task: TaskState) -> String? {
  guard let recovery = task.autoRecovery, isAutoRecovering(task) else { return nil }

  var parts: [String] = []
  if let kind = recovery.kind, !kind.isEmpty {
    parts.append(kind.replacingOccurrences(of: "_", with: " "))
  } else {
    parts.append("auto recovery")
  }

  if let totalRequeues = recovery.totalRequeues {
    if let hardCap = recovery.hardCap {
      parts.append("\(totalRequeues)/\(hardCap) requeues")
    } else {
      parts.append("\(totalRequeues) requeues")
    }
  }

  if recovery.reason == "cooldown", let nextRetry = relativeIsoTimestamp(recovery.nextEligibleAt) {
    parts.append("retry \(nextRetry)")
  }

  if let lastReason = trimSingleLine(recovery.lastReason, limit: 120) {
    parts.append(lastReason)
  }

  return parts.joined(separator: " · ")
}

func statusPriority(_ status: String) -> Int {
  switch status {
  case "running": return 0
  case "finalizing": return 1
  case "ready_to_finalize": return 2
  case "pending": return 3
  case "failed_finalize": return 4
  case "stagnant": return 5
  case "failed": return 6
  case "completed": return 7
  default: return 99
  }
}

func taskSortPriority(_ task: TaskState) -> Int {
  if let phase = queuePhase(task) {
    switch phase {
    case "awaiting_approval": return 0
    case "blocked_by_policy": return 1
    case "blocked": return 2
    case "diagnostics": return 3
    case "running", "finalizing": return 4
    case "recovering": return isRecoveryPlanningTask(task) ? 6 : 5
    case "queued": return 7
    case "completed": return 8
    default: break
    }
  }

  if isAutoRecovering(task) {
    return task.autoRecovery?.reason == "cooldown" ? 3 : 0
  }
  if isRecoveryPlanningTask(task) {
    return 5
  }
  if isDeliveryPending(task) {
    return 2
  }
  return statusPriority(task.status)
}

func sortTasks(_ tasks: [TaskState]) -> [TaskState] {
  tasks.sorted { lhs, rhs in
    let leftPriority = taskSortPriority(lhs)
    let rightPriority = taskSortPriority(rhs)
    if leftPriority != rightPriority {
      return leftPriority < rightPriority
    }
    return (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
  }
}

func taskIdentityKey(_ task: TaskState) -> String {
  let repoKey = task.repoPath ?? "unknown-repo"
  if let prdId = task.prdId, !prdId.isEmpty {
    return "\(repoKey)::prdId::\(prdId)"
  }
  if let prdPath = task.prdPath, !prdPath.isEmpty {
    return "\(repoKey)::prdPath::\(prdPath)"
  }
  return "\(repoKey)::task::\(task.id)"
}

func latestSuccessfulCompletionByIdentity(_ tasks: [TaskState]) -> [String: TimeInterval] {
  tasks.reduce(into: [String: TimeInterval]()) { result, task in
    guard isIntegratedCompletion(task) else { return }

    let key = taskIdentityKey(task)
    let updatedAt = task.updatedAt ?? 0
    if let existing = result[key], existing >= updatedAt {
      return
    }
    result[key] = updatedAt
  }
}

func isSupersededRetryTask(_ task: TaskState, latestSuccessByIdentity: [String: TimeInterval]) -> Bool {
  let isRetryState = task.status == "failed" || task.status == "failed_finalize" || task.status == "stagnant"
  guard isRetryState || isBlockedCompletion(task) else { return false }
  guard let latestSuccess = latestSuccessByIdentity[taskIdentityKey(task)] else { return false }
  return latestSuccess > (task.updatedAt ?? 0)
}

func isExecutable(_ path: String) -> Bool {
  FileManager.default.isExecutableFile(atPath: path)
}

func localRepoRootCandidate() -> String? {
  let bundleURL = Bundle.main.bundleURL
  let repoRoot = bundleURL
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path
  return FileManager.default.fileExists(atPath: repoRoot) ? repoRoot : nil
}

func resolveLocalDistCLIPath() -> String? {
  let env = ProcessInfo.processInfo.environment
  let candidates: [String?] = [
    env["RALPH_MENUBAR_CLI_JS"],
    localRepoRootCandidate().map { URL(fileURLWithPath: $0).appendingPathComponent("dist/cli.js").path },
    URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("dist/cli.js").path,
  ]

  for candidate in candidates {
    guard let candidate, !candidate.isEmpty else { continue }
    if FileManager.default.fileExists(atPath: candidate) {
      return candidate
    }
  }

  return nil
}

func makeRalphProcess(homePath: String, commandArguments: [String]) -> Process? {
  let process = Process()
  process.environment = [
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  ]

  if let cliPath = resolveLocalDistCLIPath() {
    if preferredRalphNodePaths.dropLast().contains(where: { isExecutable($0) }) {
      let nodePath = preferredRalphNodePaths.first(where: { $0 != "/usr/bin/env" && isExecutable($0) })!
      process.executableURL = URL(fileURLWithPath: nodePath)
      process.arguments = [cliPath, "--home", homePath] + commandArguments
      return process
    }

    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", cliPath, "--home", homePath] + commandArguments
    return process
  }

  if let binaryPath = preferredRalphBinaryPaths.first(where: { isExecutable($0) }) {
    process.executableURL = URL(fileURLWithPath: binaryPath)
    process.arguments = ["--home", homePath] + commandArguments
    return process
  }

  return nil
}

final class ConfigStore {
  let configURL: URL

  init() {
    let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/RalphMenuBar", isDirectory: true)
    self.configURL = supportDirectory.appendingPathComponent("config.json")
  }

  func loadOrCreate() -> RalphMenuBarConfig {
    do {
      try FileManager.default.createDirectory(
        at: configURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )

      if FileManager.default.fileExists(atPath: configURL.path) {
        let data = try Data(contentsOf: configURL)
        var config = try JSONDecoder().decode(RalphMenuBarConfig.self, from: data)
        if config.projects?.isEmpty ?? true {
          config.projects = RalphMenuBarConfig.defaultProjects(primaryHome: config.ralphHome)
          let data = try JSONEncoder.prettyPrinted.encode(config)
          try data.write(to: configURL)
        }
        return config
      }

      let config = RalphMenuBarConfig.default()
      let data = try JSONEncoder.prettyPrinted.encode(config)
      try data.write(to: configURL)
      return config
    } catch {
      return RalphMenuBarConfig.default()
    }
  }

  func save(_ config: RalphMenuBarConfig) {
    do {
      try FileManager.default.createDirectory(
        at: configURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      let data = try JSONEncoder.prettyPrinted.encode(config)
      try data.write(to: configURL)
    } catch {
      // A failed preference write should not break status monitoring.
    }
  }
}

final class SnapshotLoader {
  private let config: RalphMenuBarConfig
  private let iso8601Formatter = ISO8601DateFormatter()

  init(config: RalphMenuBarConfig) {
    self.config = config
  }

  func load() -> Snapshot {
    let homePath = expandPath(config.resolvedProjects().first?.ralphHome ?? config.ralphHome)
    return load(homePath: homePath)
  }

  func load(project: RalphMenuBarProject) -> Snapshot {
    load(homePath: expandPath(project.ralphHome))
  }

  private func load(homePath: String) -> Snapshot {
    do {
      return try loadQueueSnapshot(homePath: homePath)
    } catch {
      let fallback = loadDirectTaskSnapshot(homePath: homePath)
      return Snapshot(
        homePath: fallback.homePath,
        active: fallback.active,
        actions: fallback.actions,
        awaitingApprovalCount: fallback.awaitingApprovalCount,
        blockedCount: fallback.blockedCount,
        policyBlockedCount: fallback.policyBlockedCount,
        diagnosticsCount: fallback.diagnosticsCount,
        recentCompleted: fallback.recentCompleted,
        totalCompletedCount: fallback.totalCompletedCount,
        repoPaths: fallback.repoPaths,
        managerState: fallback.managerState,
        managerIsStale: fallback.managerIsStale,
        managerIsActive: fallback.managerIsActive,
        managerCodeDriftDetected: fallback.managerCodeDriftDetected,
        managerMessage: fallback.managerMessage,
        ingestion: fallback.ingestion,
        prdInventory: fallback.prdInventory,
        generatedAt: fallback.generatedAt,
        loadErrors: ["Queue snapshot unavailable, using direct task scan: \(error.localizedDescription)"] + fallback.loadErrors
      )
    }
  }

  private func loadQueueSnapshot(homePath: String) throws -> Snapshot {
    guard let process = makeRalphProcess(
      homePath: homePath,
      commandArguments: [
        "queue",
        "--compact",
        "--recent-completed-window-seconds", String(Int(config.recentCompletedWindowSeconds)),
        "--recent-completed-limit", String(config.recentCompletedLimit),
      ]
    ) else {
      throw NSError(domain: "RalphMenuBar", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Unable to resolve Ralph CLI or local dist/cli.js"
      ])
    }

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    let (stdoutCapture, stdoutGroup) = startPipeCapture(stdout, label: "stdout")
    let (stderrCapture, stderrGroup) = startPipeCapture(stderr, label: "stderr")

    try process.run()
    process.waitUntilExit()
    stdoutGroup.wait()
    stderrGroup.wait()

    let stdoutData = stdoutCapture.data
    let stderrData = stderrCapture.data
    let stderrText = String(data: stderrData, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard process.terminationStatus == 0 else {
      throw NSError(domain: "RalphMenuBar", code: Int(process.terminationStatus), userInfo: [
        NSLocalizedDescriptionKey: stderrText?.isEmpty == false ? stderrText! : "ralph queue exited with status \(process.terminationStatus)"
      ])
    }

    let payload = try JSONDecoder().decode(QueueSnapshotPayload.self, from: stdoutData)
    let sortedTasks = sortTasks(payload.tasks)
    let active = sortedTasks.filter { isActiveQueueTask($0) }
    let taskById = Dictionary(uniqueKeysWithValues: sortedTasks.map { ($0.id, $0) })
    let payloadActions = payload.actions ?? []
    let actions = sortTasks(payloadActions.map { taskById[$0.id] ?? $0 })
    let awaitingApprovalCount = payload.summary?.awaitingApproval
      ?? actions.filter { queuePhase($0) == "awaiting_approval" }.count
    let blockedCount = payload.summary?.blocked
      ?? actions.filter { queuePhase($0) == "blocked" }.count
    let policyBlockedCount = payload.summary?.blockedByPolicy
      ?? actions.filter { queuePhase($0) == "blocked_by_policy" }.count
    let diagnosticsCount = payload.summary?.diagnostics
      ?? actions.filter { queuePhase($0) == "diagnostics" }.count
    let recentCompleted = sortTasks(payload.recentCompleted ?? [])
    let totalCompletedCount = payload.summary?.totalCompletedCount ?? recentCompleted.count
    let generatedAt = payload.snapshotAt
      .flatMap { iso8601Formatter.date(from: $0) }
      ?? Date()

    return Snapshot(
      homePath: payload.ralphHome,
      active: active,
      actions: actions,
      awaitingApprovalCount: awaitingApprovalCount,
      blockedCount: blockedCount,
      policyBlockedCount: policyBlockedCount,
      diagnosticsCount: diagnosticsCount,
      recentCompleted: recentCompleted,
      totalCompletedCount: totalCompletedCount,
      repoPaths: payload.repoPaths,
      managerState: payload.manager?.state,
      managerIsStale: payload.manager?.heartbeatStale ?? false,
      managerIsActive: payload.manager?.active ?? false,
      managerCodeDriftDetected: payload.manager?.codeDriftDetected ?? false,
      managerMessage: payload.manager?.message ?? stderrText,
      ingestion: payload.ingestion,
      prdInventory: payload.prdInventory?.items ?? [],
      generatedAt: generatedAt,
      loadErrors: []
    )
  }

  private func loadDirectTaskSnapshot(homePath: String) -> Snapshot {
    let tasksDirectory = URL(fileURLWithPath: homePath).appendingPathComponent("tasks", isDirectory: true)
    let managerURL = URL(fileURLWithPath: homePath).appendingPathComponent("manager/state.json")
    let decoder = JSONDecoder()
    var tasks: [TaskState] = []
    var loadErrors: [String] = []

    if let entries = try? FileManager.default.contentsOfDirectory(at: tasksDirectory, includingPropertiesForKeys: nil) {
      for entry in entries {
        let stateURL = entry.appendingPathComponent("state.json")
        guard FileManager.default.fileExists(atPath: stateURL.path) else { continue }

        do {
          let data = try Data(contentsOf: stateURL)
          let task = try decoder.decode(TaskState.self, from: data)
          tasks.append(task)
        } catch {
          loadErrors.append("Failed to load \(entry.lastPathComponent): \(error.localizedDescription)")
        }
      }
    } else {
      loadErrors.append("Tasks directory not found at \(abbreviatedPath(homePath))/tasks")
    }

    let now = Date()
    let actionStatuses = Set(["failed_finalize", "failed", "stagnant"])
    let completedThreshold = now.addingTimeInterval(-config.recentCompletedWindowSeconds).timeIntervalSince1970 * 1000

    let active = sortTasks(tasks.filter { isActiveQueueTask($0) })
    let latestSuccessByIdentity = latestSuccessfulCompletionByIdentity(tasks)
    let actions = sortTasks(tasks.filter {
      return (actionStatuses.contains($0.status) || isBlockedCompletion($0))
        && !isAutoRecovering($0)
        && !isRecoveryPlanningTask($0)
        && !isWaitingForRecoveryBlocker($0)
        && !isSupersededRetryTask($0, latestSuccessByIdentity: latestSuccessByIdentity)
    })
    let recentCompleted = Array(
      sortTasks(tasks.filter { isIntegratedCompletion($0) && ($0.updatedAt ?? 0) >= completedThreshold })
        .prefix(config.recentCompletedLimit)
    )
    let totalCompletedCount = tasks.filter { isIntegratedCompletion($0) }.count

    let repoPaths = Array(Set(tasks.compactMap { $0.repoPath }.filter { !$0.isEmpty })).sorted()

    var managerState: ManagerState?
    var managerIsStale = false
    if FileManager.default.fileExists(atPath: managerURL.path) {
      do {
        let data = try Data(contentsOf: managerURL)
        managerState = try decoder.decode(ManagerState.self, from: data)
        if let heartbeat = managerState?.lastHeartbeatAt {
          let ageSeconds = now.timeIntervalSince1970 - (heartbeat / 1000)
          managerIsStale = ageSeconds > config.staleHeartbeatSeconds
        }
      } catch {
        loadErrors.append("Failed to load manager state: \(error.localizedDescription)")
      }
    }

    return Snapshot(
      homePath: homePath,
      active: active,
      actions: actions,
      awaitingApprovalCount: 0,
      blockedCount: actions.count,
      policyBlockedCount: 0,
      diagnosticsCount: 0,
      recentCompleted: recentCompleted,
      totalCompletedCount: totalCompletedCount,
      repoPaths: repoPaths,
      managerState: managerState,
      managerIsStale: managerIsStale,
      managerIsActive: managerState != nil,
      managerCodeDriftDetected: false,
      managerMessage: nil,
      ingestion: nil,
      prdInventory: [],
      generatedAt: now,
      loadErrors: loadErrors
    )
  }
}

extension JSONEncoder {
  static var prettyPrinted: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
  }
}
