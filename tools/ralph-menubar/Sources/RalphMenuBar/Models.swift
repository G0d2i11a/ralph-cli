import Foundation

private func pathExists(_ path: String) -> Bool {
  FileManager.default.fileExists(atPath: path)
}

private func looksLikeRalphHome(_ path: String) -> Bool {
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
    return false
  }

  let markers = [
    "config.json",
    "tasks",
    "manager/state.json",
    "manager.lock",
    "logs",
    "locks",
    "generated-prds",
  ]

  return markers.contains { marker in
    pathExists(URL(fileURLWithPath: path).appendingPathComponent(marker).path)
  }
}

private func hasRuntimeEvidence(_ homePath: String) -> Bool {
  let homeURL = URL(fileURLWithPath: homePath)
  if pathExists(homeURL.appendingPathComponent("manager").appendingPathComponent("state.json").path)
    || pathExists(homeURL.appendingPathComponent("manager.lock").path) {
    return true
  }

  let tasksDirectory = homeURL.appendingPathComponent("tasks", isDirectory: true)
  guard let taskDirectories = try? FileManager.default.contentsOfDirectory(
    at: tasksDirectory,
    includingPropertiesForKeys: [.isDirectoryKey],
    options: [.skipsHiddenFiles]
  ) else {
    return false
  }

  return taskDirectories.contains { $0.lastPathComponent.hasPrefix("task-") }
}

private func canonicalPath(_ path: String) -> String {
  let expanded = expandPath(path)
  return URL(fileURLWithPath: expanded).resolvingSymlinksInPath().standardized.path
}

private struct RalphHomeTaskState: Decodable {
  let repoPath: String?
}

private struct RalphHomeManagerState: Decodable {
  let repoPath: String?
  let repoPaths: [String]?
}

private func decodeJsonFile<T: Decodable>(_ type: T.Type, at path: String) -> T? {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
    return nil
  }
  return try? JSONDecoder().decode(type, from: data)
}

private func projectNameFromRepoPath(_ repoPath: String?) -> String? {
  guard let repoPath else { return nil }
  let name = URL(fileURLWithPath: repoPath).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
  return name.isEmpty ? nil : name
}

private func repoPathFromRalphHomeState(_ homePath: String) -> String? {
  let managerStatePath = URL(fileURLWithPath: homePath)
    .appendingPathComponent("manager")
    .appendingPathComponent("state.json")
    .path

  if let managerState = decodeJsonFile(RalphHomeManagerState.self, at: managerStatePath) {
    if let repoPath = managerState.repoPath?.trimmingCharacters(in: .whitespacesAndNewlines),
       !repoPath.isEmpty {
      return repoPath
    }
    if let repoPath = managerState.repoPaths?.first?.trimmingCharacters(in: .whitespacesAndNewlines),
       !repoPath.isEmpty {
      return repoPath
    }
  }

  let tasksDirectory = URL(fileURLWithPath: homePath).appendingPathComponent("tasks", isDirectory: true)
  guard let taskDirectories = try? FileManager.default.contentsOfDirectory(
    at: tasksDirectory,
    includingPropertiesForKeys: [.contentModificationDateKey],
    options: [.skipsHiddenFiles]
  ) else {
    return nil
  }

  let sortedTaskDirectories = taskDirectories.sorted { lhs, rhs in
    let lhsDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    let rhsDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    return lhsDate > rhsDate
  }

  for taskDirectory in sortedTaskDirectories {
    let statePath = taskDirectory.appendingPathComponent("state.json").path
    if let taskState = decodeJsonFile(RalphHomeTaskState.self, at: statePath),
       let repoPath = taskState.repoPath?.trimmingCharacters(in: .whitespacesAndNewlines),
       !repoPath.isEmpty {
      return repoPath
    }
  }

  return nil
}

private func projectNameFromRalphHomeState(_ homePath: String) -> String? {
  projectNameFromRepoPath(repoPathFromRalphHomeState(homePath))
}

private func discoverRalphHomeProjects() -> [RalphMenuBarProject] {
  let fileManager = FileManager.default
  let userHome = fileManager.homeDirectoryForCurrentUser
  var candidates: [String] = [
    userHome.appendingPathComponent(".ralph").path,
  ]

  if let homeEntries = try? fileManager.contentsOfDirectory(
    at: userHome,
    includingPropertiesForKeys: [.isDirectoryKey],
    options: []
  ) {
    candidates.append(contentsOf: homeEntries
      .filter { $0.lastPathComponent.hasPrefix(".ralph-") }
      .map(\.path))
  }

  let homesDirectory = userHome.appendingPathComponent(".ralph-homes", isDirectory: true)
  if let homeEntries = try? fileManager.contentsOfDirectory(
    at: homesDirectory,
    includingPropertiesForKeys: [.isDirectoryKey],
    options: [.skipsHiddenFiles]
  ) {
    candidates.append(contentsOf: homeEntries.map(\.path))
  }

  var seen = Set<String>()
  return candidates
    .map(canonicalPath)
    .filter { path in
      if seen.contains(path) || !looksLikeRalphHome(path) || !hasRuntimeEvidence(path) {
        return false
      }
      seen.insert(path)
      return true
    }
    .sorted()
    .map {
      RalphMenuBarProject(
        name: projectNameFromRalphHomeState($0) ?? RalphMenuBarConfig.inferredProjectName(for: $0),
        ralphHome: $0
      )
    }
}

private func dedupeProjectsByHomeAndRepo(_ projects: [RalphMenuBarProject]) -> [RalphMenuBarProject] {
  var seenHomes = Set<String>()
  var seenRepos = Set<String>()
  var output: [RalphMenuBarProject] = []

  for project in projects {
    let homeKey = canonicalPath(project.ralphHome)
    if seenHomes.contains(homeKey) {
      continue
    }

    if let repoPath = repoPathFromRalphHomeState(homeKey) {
      let repoKey = canonicalPath(repoPath)
      if seenRepos.contains(repoKey) {
        continue
      }
      seenRepos.insert(repoKey)
    }

    seenHomes.insert(homeKey)
    output.append(project)
  }

  return output
}

struct RalphMenuBarProject: Codable, Identifiable, Equatable {
  var name: String
  var ralphHome: String

  var id: String {
    expandPath(ralphHome)
  }
}

struct RalphMenuBarConfig: Codable {
  var ralphHome: String
  var projects: [RalphMenuBarProject]?
  var selectedProjectId: String?
  var autoDiscoverHomes: Bool?
  var refreshSeconds: TimeInterval
  var staleHeartbeatSeconds: TimeInterval
  var recentCompletedWindowSeconds: TimeInterval
  var recentCompletedLimit: Int

  static func `default`() -> RalphMenuBarConfig {
    let home = ProcessInfo.processInfo.environment["RALPH_HOME"] ?? "~/.ralph"
    return RalphMenuBarConfig(
      ralphHome: home,
      projects: defaultProjects(primaryHome: home),
      selectedProjectId: nil,
      autoDiscoverHomes: false,
      refreshSeconds: 5,
      staleHeartbeatSeconds: 900,
      recentCompletedWindowSeconds: 7200,
      recentCompletedLimit: 5
    )
  }

  static func defaultProjects(primaryHome: String) -> [RalphMenuBarProject] {
    [
      RalphMenuBarProject(
        name: inferredProjectName(for: primaryHome),
        ralphHome: primaryHome
      )
    ]
  }

  static func inferredProjectName(for ralphHome: String) -> String {
    let expandedHome = expandPath(ralphHome)
    let homeURL = URL(fileURLWithPath: expandedHome)
    let homeName = homeURL.lastPathComponent
    if homeName == ".ralph" || homeName == ".ralph-cli-home" {
      let parentName = homeURL.deletingLastPathComponent().lastPathComponent
      return parentName.isEmpty ? "default" : parentName
    }
    return homeName.isEmpty ? "default" : homeName
  }

  func resolvedProjects() -> [RalphMenuBarProject] {
    let configured = (projects ?? [])
      .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      .filter { !$0.ralphHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    let configuredOrDefault = configured.isEmpty ? Self.defaultProjects(primaryHome: ralphHome) : configured
    let discovered = autoDiscoverHomes == false ? [] : discoverRalphHomeProjects()

    return dedupeProjectsByHomeAndRepo(configuredOrDefault + discovered)
  }
}

struct StoryProgress: Decodable {
  let id: String?
  let status: String?
}

struct QueueRecoveryState: Decodable {
  let kind: String?
  let active: Bool?
  let startedAt: String?
  let deadlineAt: String?
  let nextEligibleAt: String?
  let totalRequeues: Int?
  let hardCap: Int?
  let stoppedAt: String?
  let stopReason: String?
  let lastReason: String?
}

struct QueueApprovalState: Decodable {
  let approvalId: String?
  let kind: String?
  let risk: String?
  let command: String?
  let scope: [String]?
}

struct QueuePolicyState: Decodable {
  let reason: String?
  let prohibitedAction: String?
  let configKey: String?
  let overridePath: String?
}

struct QueueStateModel: Decodable {
  let phase: String?
  let detail: String?
  let reason: String?
  let nextAction: String?
  let autonomous: Bool?
  let blockers: [String]?
  let recovery: QueueRecoveryState?
  let approval: QueueApprovalState?
  let policy: QueuePolicyState?
}

struct TaskAutoRecoveryState: Decodable {
  let kind: String?
  let active: Bool?
  let reason: String?
  let lastReason: String?
  let stopReason: String?
  let totalRequeues: Int?
  let hardCap: Int?
  let nextEligibleAt: String?
}

struct TaskDeliveryState: Decodable {
  let integrationStatus: String?
  let targetSyncStatus: String?
}

struct TaskRepairContext: Decodable {
  let mode: String?
  let storyId: String?
}

struct TaskMergeConflictState: Decodable {
  let files: [String]?
  let repairAttempts: Int?
}

struct TaskMergeRepairState: Decodable {
  let status: String?
  let storyId: String?
  let attempts: Int?
  let integrationBranch: String?
  let conflictCount: Int?
  let conflictFiles: [String]?
}

struct TaskState: Decodable, Identifiable {
  let id: String
  let status: String
  let prdId: String?
  let prdTitle: String?
  let prdPath: String?
  let repoPath: String?
  let integrationStatus: String?
  let worktree: String?
  let currentUS: String?
  let completedUS: [String]?
  let completedUSCount: Int?
  let storyProgress: [StoryProgress]?
  let updatedAt: TimeInterval?
  let errorMessage: String?
  let mergeError: String?
  let nextAction: String?
  let blockers: [String]?
  let recoveringBlockers: [String]?
  let queueState: QueueStateModel?
  let autoRecovery: TaskAutoRecoveryState?
  let delivery: TaskDeliveryState?
  let repairContext: TaskRepairContext?
  let mergeConflict: TaskMergeConflictState?
  let mergeRepair: TaskMergeRepairState?
  let mergeConflictFiles: [String]?
  let mergeRepairDisplayStatus: String?
  let mergeRepairAttempts: Int?
  let integrationBranch: String?

  enum CodingKeys: String, CodingKey {
    case id
    case status
    case prdId
    case prdTitle
    case prdPath
    case repoPath
    case integrationStatus
    case worktree
    case currentUS
    case completedUS
    case storyProgress
    case updatedAt
    case errorMessage
    case lastError
    case mergeError
    case nextAction
    case blockers
    case recoveringBlockers
    case queueState
    case autoRecovery
    case autoRecoveryKind
    case autoRecoveryNextEligibleAt
    case autoRecoveryStoppedAt
    case autoRecoveryStopReason
    case autoRecoveryLastReason
    case autoRecoveryTotalRequeues
    case autoRecoveryHardCap
    case autonomyRepairKind
    case autonomyRepairNextEligibleAt
    case autonomyRepairStoppedAt
    case autonomyRepairStopReason
    case autonomyRepairLastReason
    case autonomyRepairTotalRequeues
    case delivery
    case repairContext
    case mergeConflict
    case mergeRepair
    case mergeConflictFiles
    case mergeRepairDisplayStatus
    case mergeRepairAttempts
    case integrationBranch
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    status = try container.decode(String.self, forKey: .status)
    prdId = try container.decodeIfPresent(String.self, forKey: .prdId)
    prdTitle = try container.decodeIfPresent(String.self, forKey: .prdTitle)
    prdPath = try container.decodeIfPresent(String.self, forKey: .prdPath)
    repoPath = try container.decodeIfPresent(String.self, forKey: .repoPath)
    integrationStatus = try container.decodeIfPresent(String.self, forKey: .integrationStatus)
    worktree = try container.decodeIfPresent(String.self, forKey: .worktree)
    currentUS = try container.decodeIfPresent(String.self, forKey: .currentUS)
    if let completed = try? container.decodeIfPresent([String].self, forKey: .completedUS) {
      completedUS = completed
      completedUSCount = completed.count
    } else if let completedCount = try? container.decodeIfPresent(Int.self, forKey: .completedUS) {
      completedUS = nil
      completedUSCount = completedCount
    } else {
      completedUS = nil
      completedUSCount = nil
    }
    storyProgress = try container.decodeIfPresent([StoryProgress].self, forKey: .storyProgress)
    updatedAt = try container.decodeIfPresent(TimeInterval.self, forKey: .updatedAt)
    errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
      ?? container.decodeIfPresent(String.self, forKey: .lastError)
    mergeError = try container.decodeIfPresent(String.self, forKey: .mergeError)
    nextAction = try container.decodeIfPresent(String.self, forKey: .nextAction)
    blockers = try container.decodeIfPresent([String].self, forKey: .blockers)
    recoveringBlockers = try container.decodeIfPresent([String].self, forKey: .recoveringBlockers)
    queueState = try container.decodeIfPresent(QueueStateModel.self, forKey: .queueState)
    if let decodedAutoRecovery = try container.decodeIfPresent(TaskAutoRecoveryState.self, forKey: .autoRecovery) {
      autoRecovery = decodedAutoRecovery
    } else {
      let rawKind = try container.decodeIfPresent(String.self, forKey: .autoRecoveryKind)
        ?? container.decodeIfPresent(String.self, forKey: .autonomyRepairKind)
      let rawStoppedAt = try container.decodeIfPresent(TimeInterval.self, forKey: .autoRecoveryStoppedAt)
        ?? container.decodeIfPresent(TimeInterval.self, forKey: .autonomyRepairStoppedAt)
      let rawNextEligibleAt = try container.decodeIfPresent(TimeInterval.self, forKey: .autoRecoveryNextEligibleAt)
        ?? container.decodeIfPresent(TimeInterval.self, forKey: .autonomyRepairNextEligibleAt)
      if let rawKind {
        autoRecovery = TaskAutoRecoveryState(
          kind: rawKind,
          active: rawStoppedAt == nil,
          reason: rawNextEligibleAt.map { $0 > Date().timeIntervalSince1970 * 1000 ? "cooldown" : "autonomy_repair" },
          lastReason: try container.decodeIfPresent(String.self, forKey: .autoRecoveryLastReason)
            ?? container.decodeIfPresent(String.self, forKey: .autonomyRepairLastReason),
          stopReason: try container.decodeIfPresent(String.self, forKey: .autoRecoveryStopReason)
            ?? container.decodeIfPresent(String.self, forKey: .autonomyRepairStopReason),
          totalRequeues: try container.decodeIfPresent(Int.self, forKey: .autoRecoveryTotalRequeues)
            ?? container.decodeIfPresent(Int.self, forKey: .autonomyRepairTotalRequeues),
          hardCap: try container.decodeIfPresent(Int.self, forKey: .autoRecoveryHardCap),
          nextEligibleAt: nil
        )
      } else {
        autoRecovery = nil
      }
    }
    delivery = try container.decodeIfPresent(TaskDeliveryState.self, forKey: .delivery)
    repairContext = try container.decodeIfPresent(TaskRepairContext.self, forKey: .repairContext)
    mergeConflict = try container.decodeIfPresent(TaskMergeConflictState.self, forKey: .mergeConflict)
    mergeRepair = try container.decodeIfPresent(TaskMergeRepairState.self, forKey: .mergeRepair)
    mergeConflictFiles = try container.decodeIfPresent([String].self, forKey: .mergeConflictFiles)
    mergeRepairDisplayStatus = try container.decodeIfPresent(String.self, forKey: .mergeRepairDisplayStatus)
    mergeRepairAttempts = try container.decodeIfPresent(Int.self, forKey: .mergeRepairAttempts)
    integrationBranch = try container.decodeIfPresent(String.self, forKey: .integrationBranch)
  }
}

struct ManagerState: Decodable {
  let pid: Int?
  let status: String?
  let lastHeartbeatAt: TimeInterval?
  let repo: String?
  let updatedAt: TimeInterval?
  let autoIngestEnabled: Bool?
  let autoIngestExistingOnStartup: Bool?
}

struct ManagerStatusSnapshot: Decodable {
  let state: ManagerState?
  let active: Bool?
  let heartbeatStale: Bool?
  let codeDriftDetected: Bool?
  let message: String?
}

struct ManagerControlSnapshot: Decodable {
  let schedulingPaused: Bool?
  let pausedAt: TimeInterval?
  let pausedBy: String?
  let pauseReason: String?
  let resumedAt: TimeInterval?
  let controlPath: String?
}

struct QueueSummary: Decodable {
  let totalActive: Int?
  let running: Int?
  let recovering: Int?
  let waitingRecovery: Int?
  let awaitingApproval: Int?
  let blocked: Int?
  let blockedByPolicy: Int?
  let diagnostics: Int?
  let queued: Int?
  let planning: Int?
  let recentCompletedCount: Int?
  let totalCompletedCount: Int?
  let autoRecoveryActive: Int?
  let blockedConflict: Int?
  let byStatus: [String: Int]?
}

struct IngestionSnapshot: Decodable {
  let configuredEnabled: Bool?
  let managerAutoIngestEnabled: Bool?
  let watchDir: String?
  let pattern: String?
  let startupMode: String?
  let notIngestedCount: Int?
  let changedSinceIngestedCount: Int?
  let nextAction: String?
}

struct PrdInventoryItem: Decodable, Identifiable {
  let path: String
  let prdId: String?
  let title: String?
  let status: String
  let taskId: String?

  var id: String { path }
}

struct PrdInventorySnapshot: Decodable {
  let enabled: Bool?
  let watchDir: String?
  let pattern: String?
  let totalFiles: Int?
  let notIngestedCount: Int?
  let changedSinceIngestedCount: Int?
  let items: [PrdInventoryItem]?
}

struct QueueSnapshotPayload: Decodable {
  let schemaVersion: Int?
  let snapshotAt: String?
  let ralphHome: String
  let repoPaths: [String]
  let manager: ManagerStatusSnapshot?
  let control: ManagerControlSnapshot?
  let summary: QueueSummary?
  let actions: [TaskState]?
  let recentCompleted: [TaskState]?
  let ingestion: IngestionSnapshot?
  let prdInventory: PrdInventorySnapshot?
  let tasks: [TaskState]
}

struct Snapshot {
  let homePath: String
  let active: [TaskState]
  let actions: [TaskState]
  let awaitingApprovalCount: Int
  let blockedCount: Int
  let policyBlockedCount: Int
  let diagnosticsCount: Int
  let recentCompleted: [TaskState]
  let totalCompletedCount: Int
  let repoPaths: [String]
  let managerState: ManagerState?
  let managerControl: ManagerControlSnapshot?
  let managerIsStale: Bool
  let managerIsActive: Bool
  let managerCodeDriftDetected: Bool
  let managerMessage: String?
  let ingestion: IngestionSnapshot?
  let prdInventory: [PrdInventoryItem]
  let generatedAt: Date
  let loadErrors: [String]

  var activeCount: Int { active.count }
  var executionCount: Int { executingTasks.count }
  var recoveringCount: Int { recoveringTasks.count }
  var planningCount: Int { planningTasks.count }
  var waitingRecoveryCount: Int { waitingRecoveryTasks.count }
  var queuedCount: Int { queuedTasks.count }
  var actionCount: Int { awaitingApprovalCount + blockedCount + policyBlockedCount + diagnosticsCount }
  var recentCompletedCount: Int { recentCompleted.count }
  var isSchedulingPaused: Bool { managerControl?.schedulingPaused == true }

  var awaitingApprovalTasks: [TaskState] {
    actions.filter { queuePhase($0) == "awaiting_approval" }
  }

  var blockedTasks: [TaskState] {
    actions.filter { queuePhase($0) == "blocked" }
  }

  var policyBlockedTasks: [TaskState] {
    actions.filter { queuePhase($0) == "blocked_by_policy" }
  }

  var diagnosticsTasks: [TaskState] {
    actions.filter { queuePhase($0) == "diagnostics" }
  }

  var executingTasks: [TaskState] {
    active.filter { isExecutingQueueTask($0) }
  }

  var recoveringTasks: [TaskState] {
    active.filter { isAutoRecovering($0) && !isExecutingQueueTask($0) && !isWaitingForRecoveryBlocker($0) }
  }

  var planningTasks: [TaskState] {
    active.filter { isRecoveryPlanningTask($0) }
  }

  var waitingRecoveryTasks: [TaskState] {
    active.filter { isWaitingForRecoveryBlocker($0) }
  }

  var queuedTasks: [TaskState] {
    active.filter { isQueuedQueueTask($0) }
  }

  var stoppableRunningTasks: [TaskState] {
    executingTasks.filter { isStoppableTask($0) }
  }

  static func empty(homePath: String) -> Snapshot {
    Snapshot(
      homePath: homePath,
      active: [],
      actions: [],
      awaitingApprovalCount: 0,
      blockedCount: 0,
      policyBlockedCount: 0,
      diagnosticsCount: 0,
      recentCompleted: [],
      totalCompletedCount: 0,
      repoPaths: [],
      managerState: nil,
      managerControl: nil,
      managerIsStale: false,
      managerIsActive: false,
      managerCodeDriftDetected: false,
      managerMessage: nil,
      ingestion: nil,
      prdInventory: [],
      generatedAt: Date(),
      loadErrors: []
    )
  }
}

struct ProjectSnapshot: Identifiable {
  let project: RalphMenuBarProject
  let snapshot: Snapshot

  var id: String {
    project.id
  }
}

enum TaskSectionStyle {
  case active
  case queued
  case blocked
  case approval
  case diagnostics
  case completed
}
