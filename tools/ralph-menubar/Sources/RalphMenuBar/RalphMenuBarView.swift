import AppKit
import SwiftUI

final class SnapshotStore: ObservableObject {
  @Published private(set) var config: RalphMenuBarConfig
  @Published private(set) var snapshot: Snapshot
  @Published private(set) var projectSnapshots: [ProjectSnapshot]
  @Published var selectedProjectId: String {
    didSet {
      updateSelectedSnapshot()
    }
  }
  @Published var flashMessage: String?
  @Published var isRefreshing = false

  private let configStore = ConfigStore()
  private let loaderQueue = DispatchQueue(label: "ralph.menubar.loader", qos: .userInitiated)

  init() {
    let initialConfig = configStore.loadOrCreate()
    let projects = initialConfig.resolvedProjects()
    let initialHome = expandPath(projects.first?.ralphHome ?? initialConfig.ralphHome)
    self.config = initialConfig
    self.snapshot = Snapshot.empty(homePath: initialHome)
    self.projectSnapshots = projects.map {
      ProjectSnapshot(project: $0, snapshot: Snapshot.empty(homePath: expandPath($0.ralphHome)))
    }
    self.selectedProjectId = projects.first?.id ?? initialHome
  }

  var configPath: String {
    configStore.configURL.path
  }

  var selectedProjectName: String {
    projectSnapshots.first { $0.id == selectedProjectId }?.project.name
      ?? config.resolvedProjects().first { $0.id == selectedProjectId }?.name
      ?? shortRepoName(snapshot.repoPaths.first ?? snapshot.homePath)
  }

  var totalActiveCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.activeCount }
  }

  var totalAttentionCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.attentionCount }
  }

  var totalRecentCompletedCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.recentCompletedCount }
  }

  func refresh() {
    config = configStore.loadOrCreate()
    isRefreshing = true
    let nextConfig = config
    let projects = nextConfig.resolvedProjects()
    loaderQueue.async {
      let loader = SnapshotLoader(config: nextConfig)
      let snapshots = projects.map {
        ProjectSnapshot(project: $0, snapshot: loader.load(project: $0))
      }
      DispatchQueue.main.async {
        if !projects.contains(where: { $0.id == self.selectedProjectId }), let firstProject = projects.first {
          self.selectedProjectId = firstProject.id
        }
        self.projectSnapshots = snapshots
        self.updateSelectedSnapshot()
        self.isRefreshing = false
      }
    }
  }

  func openPath(_ path: String?) {
    guard let path, !path.isEmpty else { return }
    NSWorkspace.shared.open(URL(fileURLWithPath: expandPath(path)))
  }

  func copy(_ value: String) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(value, forType: .string)
    flash("Copied task id")
  }

  func retry(_ task: TaskState) {
    let homePath = snapshot.homePath
    guard let process = makeRalphProcess(homePath: homePath, commandArguments: ["retry", task.id]) else {
      flash("Retry failed: unable to resolve Ralph CLI")
      return
    }

    do {
      try process.run()
      flash("Retry triggered for \(shortTitle(task))")
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        self.refresh()
      }
    } catch {
      flash("Retry failed: \(error.localizedDescription)")
    }
  }

  private func flash(_ message: String) {
    flashMessage = message
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
      if self.flashMessage == message {
        self.flashMessage = nil
      }
    }
  }

  private func updateSelectedSnapshot() {
    if let selected = projectSnapshots.first(where: { $0.id == selectedProjectId }) {
      snapshot = selected.snapshot
      return
    }

    if let first = projectSnapshots.first {
      snapshot = first.snapshot
      return
    }

    snapshot = Snapshot.empty(homePath: expandPath(config.ralphHome))
  }
}

struct RalphMenuBarView: View {
  @ObservedObject var store: SnapshotStore

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header

          if let criticalMessage {
            CriticalBanner(message: criticalMessage, tone: criticalTone)
          }

          if !store.snapshot.attention.isEmpty {
            TaskSectionView(
              title: "Needs Action",
              subtitle: "Failed, stalled, and blocked merge work",
              tasks: store.snapshot.attention,
              style: .attention,
              store: store
            )
          }

          TaskSectionView(
            title: "Running Now",
            subtitle: store.snapshot.active.isEmpty
              ? "Ralph is idle."
              : "Queued, running, and finalizing work",
            tasks: store.snapshot.active,
            style: .active,
            store: store
          )

          TaskSectionView(
            title: "Recent Integrated",
            subtitle: "Latest merged outcomes",
            tasks: store.snapshot.recentCompleted,
            style: .completed,
            store: store
          )
        }
        .padding(16)
      }
      .scrollIndicators(.never)

      footer
    }
    .frame(width: 468, height: 620)
    .background(
      ZStack {
        Color(nsColor: NSColor.windowBackgroundColor)
        Rectangle()
          .fill(.ultraThinMaterial)
          .ignoresSafeArea()
      }
    )
    .overlay(alignment: .bottom) {
      if let flashMessage = store.flashMessage {
        FlashToast(message: flashMessage)
          .padding(.bottom, 12)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 10) {
            Image(systemName: healthSymbol)
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(.white)
              .frame(width: 30, height: 30)
              .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .fill(healthTint.gradient)
              )

            VStack(alignment: .leading, spacing: 2) {
              Text(healthHeadline)
                .font(.system(size: 17, weight: .semibold))
              Text(healthDetail)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            }
          }
        }

        Spacer()

        VStack(alignment: .trailing, spacing: 4) {
          Text(store.isRefreshing ? "Refreshing" : "Updated \(relativeTimestamp(store.snapshot.generatedAt.timeIntervalSince1970 * 1000))")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
          Text(abbreviatedPath(store.snapshot.homePath))
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
        }
      }

      if store.projectSnapshots.count > 1 {
        Picker("Project", selection: $store.selectedProjectId) {
          ForEach(store.projectSnapshots) { projectSnapshot in
            Text(projectSnapshot.project.name)
              .tag(projectSnapshot.id)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
      }

      HStack(spacing: 10) {
        SummaryPill(title: "Running", value: store.snapshot.activeCount, tint: .blue)
        SummaryPill(title: "Attention", value: store.snapshot.attentionCount, tint: .orange)
        SummaryPill(title: "Integrated", value: store.snapshot.recentCompletedCount, tint: .green)
      }

      if !store.snapshot.repoPaths.isEmpty {
        HStack(spacing: 8) {
          ForEach(store.snapshot.repoPaths, id: \.self) { path in
            Text(shortRepoName(path))
              .font(.system(size: 11, weight: .medium))
              .padding(.horizontal, 8)
              .padding(.vertical, 5)
              .background(
                Capsule(style: .continuous)
                  .fill(Color.primary.opacity(0.08))
              )
          }
        }
      }
    }
  }

  private var footer: some View {
    HStack(spacing: 10) {
      ToolbarButton(label: "Open Home", systemImage: "folder") {
        store.openPath(store.snapshot.homePath)
      }
      ToolbarButton(label: "Refresh", systemImage: "arrow.clockwise") {
        store.refresh()
      }
      ToolbarButton(label: "Config", systemImage: "slider.horizontal.3") {
        store.openPath(store.configPath)
      }
      Spacer()
      ToolbarButton(label: "Quit", systemImage: "power") {
        NSApp.terminate(nil)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.thinMaterial)
  }

  private var criticalMessage: String? {
    if !store.snapshot.loadErrors.isEmpty {
      return store.snapshot.loadErrors.first
    }
    if store.snapshot.managerCodeDriftDetected {
      return store.snapshot.managerMessage ?? "Manager is running older Ralph code than what is on disk."
    }
    if store.snapshot.managerIsStale {
      return "Manager heartbeat is stale. Retry and merge actions may lag."
    }
    if store.snapshot.managerState != nil && !store.snapshot.managerIsActive {
      return store.snapshot.managerMessage ?? "Manager is not active for this Ralph home."
    }
    if store.snapshot.managerState == nil {
      return "Manager state is missing for this Ralph home."
    }
    if store.snapshot.attentionCount > 0 {
      return "\(store.snapshot.attentionCount) task\(store.snapshot.attentionCount == 1 ? "" : "s") need attention."
    }
    return nil
  }

  private var criticalTone: Color {
    if !store.snapshot.loadErrors.isEmpty
      || store.snapshot.managerState == nil
      || store.snapshot.managerCodeDriftDetected
      || (store.snapshot.managerState != nil && !store.snapshot.managerIsActive) {
      return .red
    }
    return .orange
  }

  private var healthHeadline: String {
    if !store.snapshot.loadErrors.isEmpty {
      return "Load issues detected"
    }
    if store.snapshot.managerCodeDriftDetected {
      return "Manager restart required"
    }
    if store.snapshot.managerIsStale {
      return "Manager stale"
    }
    if store.snapshot.managerState != nil && !store.snapshot.managerIsActive {
      return "Manager inactive"
    }
    if store.snapshot.attentionCount > 0 {
      return "\(store.snapshot.attentionCount) task\(store.snapshot.attentionCount == 1 ? "" : "s") need attention"
    }
    if store.snapshot.activeCount > 0 {
      return "\(store.snapshot.activeCount) task\(store.snapshot.activeCount == 1 ? "" : "s") running"
    }
    return "Ralph is idle"
  }

  private var healthDetail: String {
    if store.snapshot.managerCodeDriftDetected, let message = store.snapshot.managerMessage {
      return message
    }
    if let manager = store.snapshot.managerState, let heartbeat = manager.lastHeartbeatAt {
      return "\(store.selectedProjectName) · manager \(manager.status ?? "unknown") · heartbeat \(relativeTimestamp(heartbeat))"
    }
    return "\(store.selectedProjectName) · \(abbreviatedPath(store.snapshot.homePath))"
  }

  private var healthSymbol: String {
    if !store.snapshot.loadErrors.isEmpty
      || store.snapshot.managerState == nil
      || store.snapshot.managerCodeDriftDetected
      || (store.snapshot.managerState != nil && !store.snapshot.managerIsActive) {
      return "exclamationmark.octagon.fill"
    }
    if store.snapshot.managerIsStale || store.snapshot.attentionCount > 0 {
      return "exclamationmark.triangle.fill"
    }
    if store.snapshot.activeCount > 0 {
      return "bolt.fill"
    }
    return "checkmark.circle.fill"
  }

  private var healthTint: Color {
    if !store.snapshot.loadErrors.isEmpty
      || store.snapshot.managerState == nil
      || store.snapshot.managerCodeDriftDetected
      || (store.snapshot.managerState != nil && !store.snapshot.managerIsActive) {
      return .red
    }
    if store.snapshot.managerIsStale || store.snapshot.attentionCount > 0 {
      return .orange
    }
    if store.snapshot.activeCount > 0 {
      return .blue
    }
    return .green
  }
}

struct SummaryPill: View {
  let title: String
  let value: Int
  let tint: Color

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(tint)
        .frame(width: 8, height: 8)
      Text(title)
        .font(.system(size: 12, weight: .medium))
      Text("\(value)")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.primary)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(
      Capsule(style: .continuous)
        .fill(tint.opacity(0.12))
    )
  }
}

struct ToolbarButton: View {
  let label: String
  let systemImage: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(label, systemImage: systemImage)
        .font(.system(size: 12, weight: .medium))
        .frame(minWidth: 0)
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
  }
}

struct FlashToast: View {
  let message: String

  var body: some View {
    Text(message)
      .font(.system(size: 12, weight: .medium))
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(.regularMaterial, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
      )
  }
}

struct CriticalBanner: View {
  let message: String
  let tone: Color

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: tone == .red ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(tone)

      Text(message)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(tone.opacity(0.10))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(tone.opacity(0.20), lineWidth: 1)
    )
  }
}

struct TaskSectionView: View {
  let title: String
  let subtitle: String
  let tasks: [TaskState]
  let style: TaskSectionStyle
  @ObservedObject var store: SnapshotStore

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
        Text(subtitle)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.secondary)
      }

      if tasks.isEmpty {
        EmptySectionCard(text: emptyText)
      } else {
        ForEach(tasks) { task in
          TaskRowView(task: task, style: style, store: store)
        }
      }
    }
  }

  private var emptyText: String {
    switch style {
    case .attention:
      return "Nothing is blocked right now."
    case .active:
      return "No active work in this Ralph home."
    case .completed:
      return "No recent integrated tasks in the current window."
    }
  }
}

struct EmptySectionCard: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.primary.opacity(0.05))
      )
  }
}

struct TaskRowView: View {
  let task: TaskState
  let style: TaskSectionStyle
  @ObservedObject var store: SnapshotStore

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(accentColor)
        .frame(width: 4)

      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(shortRepoName(task.repoPath))
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
              Capsule(style: .continuous)
                .fill(Color.primary.opacity(0.07))
            )

          StatusChip(task: task)

          Spacer()

          Text(relativeTimestamp(task.updatedAt))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
        }

        Text(shortTitle(task))
          .font(.system(size: style == .completed ? 13 : 14, weight: .semibold))
          .fixedSize(horizontal: false, vertical: true)

        if let summary = storySummary(task) {
          VStack(alignment: .leading, spacing: 6) {
            Text(summary)
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(.secondary)

            let counts = storyCounts(task)
            if counts.total > 0 {
              ProgressView(value: Double(counts.completed), total: Double(counts.total))
                .progressViewStyle(.linear)
                .tint(accentColor)
            }
          }
        }

        if let errorSnippet = trimSingleLine(task.errorMessage ?? task.mergeError ?? task.nextAction ?? task.attentionReason) {
          Text(errorSnippet)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(style == .attention ? .orange : .secondary)
            .lineLimit(3)
        }

        HStack(spacing: 8) {
          if let primaryAction {
            Button(action: primaryAction.action) {
              Label(primaryAction.title, systemImage: primaryAction.systemImage)
                .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(accentColor)
          }

          Menu {
            Button("Open Repo", systemImage: "folder") {
              store.openPath(task.repoPath)
            }
            Button("Open Worktree", systemImage: "shippingbox") {
              store.openPath(task.worktree)
            }
            Button("Open PRD", systemImage: "doc.text") {
              store.openPath(task.prdPath)
            }
            Divider()
            Button("Copy Task ID", systemImage: "number") {
              store.copy(task.id)
            }
          } label: {
            Image(systemName: "ellipsis")
              .font(.system(size: 12, weight: .semibold))
              .frame(width: 28, height: 28)
          }
          .menuStyle(.borderlessButton)
        }
      }
      .padding(12)
    }
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.primary.opacity(0.035))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private var accentColor: Color {
    switch style {
    case .active:
      return .blue
    case .attention:
      return .orange
    case .completed:
      return .green
    }
  }

  private var primaryAction: (title: String, systemImage: String, action: () -> Void)? {
    switch task.status {
    case "failed", "failed_finalize":
      return ("Retry", "arrow.clockwise", { store.retry(task) })
    case "running", "pending", "ready_to_finalize", "finalizing":
      return ("Open Worktree", "shippingbox", { store.openPath(task.worktree) })
    case "completed":
      if task.prdPath != nil {
        return ("Open PRD", "doc.text", { store.openPath(task.prdPath) })
      }
      return ("Open Repo", "folder", { store.openPath(task.repoPath) })
    default:
      return ("Open Repo", "folder", { store.openPath(task.repoPath) })
    }
  }
}

struct StatusChip: View {
  let task: TaskState

  var body: some View {
    Text(statusDisplayLabel(task))
      .font(.system(size: 10, weight: .semibold))
      .textCase(.uppercase)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(
        Capsule(style: .continuous)
          .fill(badgeColor.opacity(0.14))
      )
      .foregroundStyle(badgeColor)
  }

  private var badgeColor: Color {
    if isBlockedCompletion(task) {
      return .orange
    }

    if isIntegratedCompletion(task) {
      return .green
    }

    switch task.status {
    case "running":
      return .blue
    case "finalizing", "ready_to_finalize":
      return .purple
    case "pending":
      return .gray
    case "failed", "failed_finalize":
      return .orange
    default:
      return .secondary
    }
  }
}
