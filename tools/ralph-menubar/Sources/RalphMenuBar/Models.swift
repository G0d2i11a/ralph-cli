import Foundation

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
  var refreshSeconds: TimeInterval
  var staleHeartbeatSeconds: TimeInterval
  var recentCompletedWindowSeconds: TimeInterval
  var recentCompletedLimit: Int

  static func `default`() -> RalphMenuBarConfig {
    let home = ProcessInfo.processInfo.environment["RALPH_HOME"] ?? "~/.ralph"
    return RalphMenuBarConfig(
      ralphHome: home,
      projects: defaultProjects(primaryHome: home),
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

    if configured.isEmpty {
      return Self.defaultProjects(primaryHome: ralphHome)
    }

    var seen = Set<String>()
    return configured.filter { project in
      let key = expandPath(project.ralphHome)
      if seen.contains(key) {
        return false
      }
      seen.insert(key)
      return true
    }
  }
}

struct StoryProgress: Decodable {
  let id: String?
  let status: String?
}

struct TaskAttentionState: Decodable {
  let needed: Bool
  let reason: String?
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
  let attention: TaskAttentionState?
  let attentionReason: String?

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
    case attention
    case attentionReason
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
    attention = try container.decodeIfPresent(TaskAttentionState.self, forKey: .attention)
    attentionReason = try container.decodeIfPresent(String.self, forKey: .attentionReason)
  }
}

struct ManagerState: Decodable {
  let pid: Int?
  let status: String?
  let lastHeartbeatAt: TimeInterval?
  let repo: String?
  let updatedAt: TimeInterval?
}

struct ManagerStatusSnapshot: Decodable {
  let state: ManagerState?
  let active: Bool?
  let heartbeatStale: Bool?
  let codeDriftDetected: Bool?
  let message: String?
}

struct QueueSummary: Decodable {
  let totalActive: Int?
  let totalAttention: Int?
  let recentCompletedCount: Int?
  let autoRecoveryActive: Int?
  let blockedConflict: Int?
  let byStatus: [String: Int]?
}

struct QueueSnapshotPayload: Decodable {
  let snapshotAt: String?
  let ralphHome: String
  let repoPaths: [String]
  let manager: ManagerStatusSnapshot?
  let summary: QueueSummary?
  let attention: [TaskState]?
  let recentCompleted: [TaskState]?
  let tasks: [TaskState]
}

struct Snapshot {
  let homePath: String
  let active: [TaskState]
  let attention: [TaskState]
  let recentCompleted: [TaskState]
  let repoPaths: [String]
  let managerState: ManagerState?
  let managerIsStale: Bool
  let managerIsActive: Bool
  let managerCodeDriftDetected: Bool
  let managerMessage: String?
  let generatedAt: Date
  let loadErrors: [String]

  var activeCount: Int { active.count }
  var attentionCount: Int { attention.count }
  var recentCompletedCount: Int { recentCompleted.count }

  static func empty(homePath: String) -> Snapshot {
    Snapshot(
      homePath: homePath,
      active: [],
      attention: [],
      recentCompleted: [],
      repoPaths: [],
      managerState: nil,
      managerIsStale: false,
      managerIsActive: false,
      managerCodeDriftDetected: false,
      managerMessage: nil,
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
  case attention
  case completed
}
