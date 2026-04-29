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
  if let currentUS = task.currentUS, !currentUS.isEmpty {
    return "Story progress \(counts.completed)/\(counts.total), current \(currentUS)"
  }
  return "Story progress \(counts.completed)/\(counts.total)"
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

func isIntegratedCompletion(_ task: TaskState) -> Bool {
  task.status == "completed" && (task.integrationStatus == nil || task.integrationStatus == "integrated")
}

func isBlockedCompletion(_ task: TaskState) -> Bool {
  task.status == "completed" && task.integrationStatus == "blocked_conflict"
}

func statusDisplayLabel(_ task: TaskState) -> String {
  if isBlockedCompletion(task) {
    return "Merge blocked"
  }

  if isIntegratedCompletion(task) {
    return "Integrated"
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

func sortTasks(_ tasks: [TaskState]) -> [TaskState] {
  tasks.sorted { lhs, rhs in
    let leftPriority = statusPriority(lhs.status)
    let rightPriority = statusPriority(rhs.status)
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

func isSupersededAttentionTask(_ task: TaskState, latestSuccessByIdentity: [String: TimeInterval]) -> Bool {
  let isRetryAttention = task.status == "failed" || task.status == "failed_finalize" || task.status == "stagnant"
  guard isRetryAttention || isBlockedCompletion(task) else { return false }
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
    "~/Project/ralph-cli/dist/cli.js",
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
      let fallback = loadLegacySnapshot(homePath: homePath)
      return Snapshot(
        homePath: fallback.homePath,
        active: fallback.active,
        attention: fallback.attention,
        recentCompleted: fallback.recentCompleted,
        repoPaths: fallback.repoPaths,
        managerState: fallback.managerState,
        managerIsStale: fallback.managerIsStale,
        managerIsActive: fallback.managerIsActive,
        managerCodeDriftDetected: fallback.managerCodeDriftDetected,
        managerMessage: fallback.managerMessage,
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
    let activeStatuses = Set(["pending", "running", "ready_to_finalize", "finalizing"])
    let sortedTasks = sortTasks(payload.tasks)
    let active = sortedTasks.filter { activeStatuses.contains($0.status) }
    let attention = sortTasks(sortedTasks.filter { $0.attention?.needed == true })
    let recentCompleted = sortTasks(payload.recentCompleted ?? [])
    let generatedAt = payload.snapshotAt
      .flatMap { iso8601Formatter.date(from: $0) }
      ?? Date()

    return Snapshot(
      homePath: payload.ralphHome,
      active: active,
      attention: attention,
      recentCompleted: recentCompleted,
      repoPaths: payload.repoPaths,
      managerState: payload.manager?.state,
      managerIsStale: payload.manager?.heartbeatStale ?? false,
      managerIsActive: payload.manager?.active ?? false,
      managerCodeDriftDetected: payload.manager?.codeDriftDetected ?? false,
      managerMessage: payload.manager?.message ?? stderrText,
      generatedAt: generatedAt,
      loadErrors: []
    )
  }

  private func loadLegacySnapshot(homePath: String) -> Snapshot {
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
    let activeStatuses = Set(["pending", "running", "ready_to_finalize", "finalizing"])
    let attentionStatuses = Set(["failed_finalize", "failed", "stagnant"])
    let completedThreshold = now.addingTimeInterval(-config.recentCompletedWindowSeconds).timeIntervalSince1970 * 1000

    let active = sortTasks(tasks.filter { activeStatuses.contains($0.status) })
    let latestSuccessByIdentity = latestSuccessfulCompletionByIdentity(tasks)
    let attention = sortTasks(tasks.filter {
      return (attentionStatuses.contains($0.status) || isBlockedCompletion($0))
        && !isSupersededAttentionTask($0, latestSuccessByIdentity: latestSuccessByIdentity)
    })
    let recentCompleted = Array(
      sortTasks(tasks.filter { isIntegratedCompletion($0) && ($0.updatedAt ?? 0) >= completedThreshold })
        .prefix(config.recentCompletedLimit)
    )

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
      attention: attention,
      recentCompleted: recentCompleted,
      repoPaths: repoPaths,
      managerState: managerState,
      managerIsStale: managerIsStale,
      managerIsActive: managerState != nil,
      managerCodeDriftDetected: false,
      managerMessage: nil,
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
