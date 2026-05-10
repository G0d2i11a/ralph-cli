import AppKit
import SwiftUI

final class SnapshotStore: ObservableObject {
  @Published private(set) var config: RalphMenuBarConfig
  @Published private(set) var snapshot: Snapshot
  @Published private(set) var projectSnapshots: [ProjectSnapshot]
  @Published var selectedProjectId: String {
    didSet {
      updateSelectedSnapshot()
      persistSelectedProjectSelection()
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
    let initialSelectedProjectId = initialConfig.selectedProjectId
    self.selectedProjectId = initialSelectedProjectId.flatMap { selectedId in
      projects.first(where: { $0.id == selectedId })?.id
    }
      ?? projects.first?.id
      ?? initialHome
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

  var totalExecutionCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.executionCount }
  }

  var totalRecoveringCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.recoveringCount }
  }

  var totalPlanningCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.planningCount }
  }

  var totalWaitingRecoveryCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.waitingRecoveryCount }
  }

  var totalQueuedCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.queuedCount }
  }

  var totalActionCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.actionCount }
  }

  var totalRecentCompletedCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.recentCompletedCount }
  }

  var totalCompletedCount: Int {
    projectSnapshots.reduce(0) { $0 + $1.snapshot.totalCompletedCount }
  }

  var notIngestedCount: Int {
    snapshot.ingestion?.notIngestedCount
      ?? snapshot.prdInventory.filter { $0.status == "not_ingested" }.count
  }

  var changedPrdCount: Int {
    snapshot.ingestion?.changedSinceIngestedCount
      ?? snapshot.prdInventory.filter { $0.status == "changed_since_ingested" }.count
  }

  var visibleRepoPaths: [String] {
    let paths = snapshot.repoPaths
    if paths.count == 1, repoNameMatchesSelectedProject(paths[0]) {
      return []
    }
    return paths
  }

  func shouldShowRepoBadge(for repoPath: String?) -> Bool {
    guard let repoPath, !repoPath.isEmpty else { return false }
    if snapshot.repoPaths.count > 1 {
      return true
    }
    return !repoNameMatchesSelectedProject(repoPath)
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
        let projectIds = Set(projects.map(\.id))
        let savedProjectId = nextConfig.selectedProjectId.flatMap { projectIds.contains($0) ? $0 : nil }
        let activeProjectId = snapshots.first {
          $0.snapshot.actionCount > 0 || $0.snapshot.executionCount > 0 || $0.snapshot.waitingRecoveryCount > 0
        }?.id

        if let savedProjectId, self.selectedProjectId != savedProjectId {
          self.selectedProjectId = savedProjectId
        } else if savedProjectId == nil, let activeProjectId, self.selectedProjectId != activeProjectId {
          self.selectedProjectId = activeProjectId
        } else if !projectIds.contains(self.selectedProjectId), let firstProject = projects.first {
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

  private func persistSelectedProjectSelection() {
    guard config.selectedProjectId != selectedProjectId else { return }
    var nextConfig = config
    nextConfig.selectedProjectId = selectedProjectId
    config = nextConfig
    configStore.save(nextConfig)
  }

  private func repoNameMatchesSelectedProject(_ repoPath: String) -> Bool {
    shortRepoName(repoPath).caseInsensitiveCompare(selectedProjectName) == .orderedSame
  }
}

struct RalphMenuBarView: View {
  @ObservedObject var store: SnapshotStore
  @State private var isDashboardExpanded = true

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header

          if let criticalMessage {
            CriticalBanner(message: criticalMessage, tone: criticalTone)
          }

          if isDashboardExpanded {
            fullDashboard
          } else {
            compactDashboard
          }
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

  @ViewBuilder
  private var fullDashboard: some View {
    if !store.snapshot.awaitingApprovalTasks.isEmpty {
      TaskSectionView(
        title: "Awaiting Approval",
        subtitle: "Narrow unsafe actions that need explicit approval",
        tasks: store.snapshot.awaitingApprovalTasks,
        style: .approval,
        store: store
      )
    }

    if !store.snapshot.policyBlockedTasks.isEmpty || !store.snapshot.blockedTasks.isEmpty || !store.snapshot.diagnosticsTasks.isEmpty {
      TaskSectionView(
        title: "Blocked",
        subtitle: "Dependency, baseline, environment, policy, or diagnostic blockers",
        tasks: store.snapshot.policyBlockedTasks + store.snapshot.blockedTasks + store.snapshot.diagnosticsTasks,
        style: .blocked,
        store: store
      )
    }

    TaskSectionView(
      title: "In Progress",
      subtitle: executingTasks.isEmpty
        ? "No PRDs are actively executing."
        : "PRDs with an active worker, validator, or finalizer",
      tasks: executingTasks,
      style: .active,
      store: store
    )

    if !planningTasks.isEmpty {
      TaskSectionView(
        title: "Autonomy Planning",
        subtitle: "Follow-up PRDs or story splits being prepared automatically",
        tasks: planningTasks,
        style: .queued,
        store: store
      )
    }

    TaskSectionView(
      title: "Queued / Blocked",
      subtitle: waitingOrQueuedTasks.isEmpty
        ? "No PRDs are waiting for dependencies or slots."
        : "PRDs waiting for dependencies, integration, or capacity",
      tasks: waitingOrQueuedTasks,
      style: .queued,
      store: store
    )

    if !pendingInventoryItems.isEmpty {
      PrdInventorySectionView(
        title: "Not Ingested",
        subtitle: inventorySubtitle,
        items: pendingInventoryItems,
        store: store
      )
    }

    TaskSectionView(
      title: "PRD History",
      subtitle: "Recent completed: \(store.snapshot.recentCompletedCount) · Total completed: \(store.snapshot.totalCompletedCount)",
      tasks: store.snapshot.recentCompleted,
      style: .completed,
      store: store
    )
  }

  private var compactDashboard: some View {
    CompactOverviewCard(
      selectedProjectName: store.selectedProjectName,
      actionTasks: store.snapshot.actions,
      inProgressTasks: executingTasks,
      repairingCount: recoveringTasks.count,
      planningTasks: planningTasks,
      waitingCount: waitingRecoveryTasks.count,
      queuedTasks: queuedTasks,
      recentCompletedTasks: store.snapshot.recentCompleted,
      totalCompletedCount: store.snapshot.totalCompletedCount,
      notIngestedCount: store.notIngestedCount,
      ingestionNextAction: store.snapshot.ingestion?.nextAction
    ) {
      withAnimation(.easeInOut(duration: 0.18)) {
        isDashboardExpanded = true
      }
    }
  }

  private var executingTasks: [TaskState] {
    store.snapshot.executingTasks
  }

  private var recoveringTasks: [TaskState] {
    store.snapshot.recoveringTasks
  }

  private var planningTasks: [TaskState] {
    store.snapshot.planningTasks
  }

  private var waitingRecoveryTasks: [TaskState] {
    store.snapshot.waitingRecoveryTasks
  }

  private var queuedTasks: [TaskState] {
    store.snapshot.queuedTasks
  }

  private var waitingOrQueuedTasks: [TaskState] {
    waitingRecoveryTasks + queuedTasks
  }

  private var pendingInventoryItems: [PrdInventoryItem] {
    store.snapshot.prdInventory
      .filter { $0.status == "not_ingested" || $0.status == "changed_since_ingested" }
      .prefix(10)
      .map { $0 }
  }

  private var inventorySubtitle: String {
    var parts: [String] = []
    if store.notIngestedCount > 0 {
      parts.append("\(store.notIngestedCount) PRD\(store.notIngestedCount == 1 ? "" : "s") on disk are not queued")
    }
    if store.changedPrdCount > 0 {
      parts.append("\(store.changedPrdCount) changed since ingest")
    }
    if let nextAction = trimSingleLine(store.snapshot.ingestion?.nextAction, limit: 120) {
      parts.append(nextAction)
    }
    return parts.isEmpty ? "PRD inventory is clear" : parts.joined(separator: " · ")
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

      summaryPills

      if !store.visibleRepoPaths.isEmpty {
        HStack(spacing: 8) {
          ForEach(store.visibleRepoPaths, id: \.self) { path in
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

  private var summaryPills: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        SummaryPill(title: "Running", value: executingTasks.count, tint: .blue)
        SummaryPill(title: "Repairing", value: recoveringTasks.count, tint: .blue)
        SummaryPill(title: "Planning", value: planningTasks.count, tint: .gray)
        SummaryPill(title: "Approval", value: store.snapshot.awaitingApprovalCount, tint: .orange)
      }

      HStack(spacing: 10) {
        SummaryPill(title: "Blocked", value: store.snapshot.blockedCount + store.snapshot.policyBlockedCount + store.snapshot.diagnosticsCount, tint: .orange)
        SummaryPill(title: "Queued", value: queuedTasks.count, tint: .gray)
        SummaryPill(title: "Recent", value: store.snapshot.recentCompletedCount, tint: .green)
        SummaryPill(title: "Total", value: store.snapshot.totalCompletedCount, tint: .teal)
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
    if store.snapshot.awaitingApprovalCount > 0 {
      return "\(store.snapshot.awaitingApprovalCount) task\(store.snapshot.awaitingApprovalCount == 1 ? "" : "s") awaiting approval."
    }
    if store.snapshot.policyBlockedCount > 0 || store.snapshot.blockedCount > 0 || store.snapshot.diagnosticsCount > 0 {
      return "\(store.snapshot.actionCount) task\(store.snapshot.actionCount == 1 ? "" : "s") blocked or diagnosing."
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
    if store.snapshot.awaitingApprovalCount > 0 {
      return "\(store.snapshot.awaitingApprovalCount) awaiting approval"
    }
    if store.snapshot.policyBlockedCount > 0 {
      return "\(store.snapshot.policyBlockedCount) blocked by policy"
    }
    if store.snapshot.blockedCount > 0 || store.snapshot.diagnosticsCount > 0 {
      return "\(store.snapshot.blockedCount + store.snapshot.diagnosticsCount) blocked or diagnosing"
    }
    if store.snapshot.executionCount > 0 {
      let recoveringSuffix = store.snapshot.recoveringCount > 0 ? " · \(store.snapshot.recoveringCount) repairing" : ""
      let planningSuffix = store.snapshot.planningCount > 0 ? " · \(store.snapshot.planningCount) planning" : ""
      let waitingSuffix = store.snapshot.waitingRecoveryCount > 0 ? " · \(store.snapshot.waitingRecoveryCount) waiting" : ""
      return "\(store.snapshot.executionCount) task\(store.snapshot.executionCount == 1 ? "" : "s") active\(recoveringSuffix)\(planningSuffix)\(waitingSuffix)"
    }
    if store.snapshot.recoveringCount > 0 {
      let waitingSuffix = store.snapshot.waitingRecoveryCount > 0 ? " · \(store.snapshot.waitingRecoveryCount) waiting" : ""
      let planningSuffix = store.snapshot.planningCount > 0 ? " · \(store.snapshot.planningCount) planning" : ""
      return "\(store.snapshot.recoveringCount) repairing\(planningSuffix)\(waitingSuffix)"
    }
    if store.snapshot.planningCount > 0 {
      return "\(store.snapshot.planningCount) planning autonomous follow-up"
    }
    if store.snapshot.waitingRecoveryCount > 0 {
      return "\(store.snapshot.waitingRecoveryCount) waiting on recovery"
    }
    if store.snapshot.queuedCount > 0 {
      return "\(store.snapshot.queuedCount) queued"
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
    if store.snapshot.managerIsStale || store.snapshot.actionCount > 0 {
      return "exclamationmark.triangle.fill"
    }
    if store.snapshot.executionCount > 0 {
      return "bolt.fill"
    }
    if store.snapshot.planningCount > 0 || store.snapshot.waitingRecoveryCount > 0 || store.snapshot.queuedCount > 0 {
      return "clock"
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
    if store.snapshot.managerIsStale || store.snapshot.actionCount > 0 {
      return .orange
    }
    if store.snapshot.executionCount > 0 {
      return .blue
    }
    if store.snapshot.planningCount > 0 || store.snapshot.waitingRecoveryCount > 0 || store.snapshot.queuedCount > 0 {
      return .gray
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

func isBlockStyle(_ style: TaskSectionStyle) -> Bool {
  style == .approval || style == .blocked || style == .diagnostics
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

struct CompactOverviewCard: View {
  let selectedProjectName: String
  let actionTasks: [TaskState]
  let inProgressTasks: [TaskState]
  let repairingCount: Int
  let planningTasks: [TaskState]
  let waitingCount: Int
  let queuedTasks: [TaskState]
  let recentCompletedTasks: [TaskState]
  let totalCompletedCount: Int
  let notIngestedCount: Int
  let ingestionNextAction: String?
  let onExpand: () -> Void

  var body: some View {
    Button(action: onExpand) {
      content
    }
    .buttonStyle(.plain)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Label("Compact View", systemImage: "rectangle.compress.vertical")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)

        Spacer()

        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.secondary)
      }

      Text(statusLine)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)

      if notIngestedCount > 0, let ingestionNextAction = trimSingleLine(ingestionNextAction, limit: 120) {
        Text("\(notIngestedCount) PRDs on disk are not queued · \(ingestionNextAction)")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.orange)
          .lineLimit(1)
          .truncationMode(.tail)
      }

      if let spotlightTask {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          StatusChip(task: spotlightTask.task)

          Text(shortTitle(spotlightTask.task))
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)
            .truncationMode(.tail)

          Spacer()

          Text(relativeTimestamp(spotlightTask.task.updatedAt))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
        }

        if let summary = compactSummary(for: spotlightTask.task) {
          Text(summary)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(isBlockStyle(spotlightTask.style) ? .orange : .secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      } else {
        Text("No active or recent task details in compact mode.")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.secondary)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.primary.opacity(0.045))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
    )
  }

  private var statusLine: String {
    let inventoryPart = notIngestedCount > 0 ? " · \(notIngestedCount) not queued" : ""
    return "\(selectedProjectName) · \(actionTasks.count) blocked/approval · \(inProgressTasks.count) running · \(repairingCount) repairing · \(planningTasks.count) planning · \(waitingCount) waiting · \(queuedTasks.count) queued · \(recentCompletedTasks.count) recent · \(totalCompletedCount) total\(inventoryPart)"
  }

  private var spotlightTask: (task: TaskState, style: TaskSectionStyle)? {
    if let task = actionTasks.first {
      return (task, queuePhase(task) == "awaiting_approval" ? .approval : .blocked)
    }
    if let task = inProgressTasks.first {
      return (task, .active)
    }
    if let task = planningTasks.first {
      return (task, .queued)
    }
    if let task = queuedTasks.first {
      return (task, .queued)
    }
    if let task = recentCompletedTasks.first {
      return (task, .completed)
    }
    return nil
  }

  private func compactSummary(for task: TaskState) -> String? {
    let candidates = [
      storySummary(task),
      taskStageSummary(task),
      taskErrorSnippet(task),
    ].compactMap { $0 }

    var seen = Set<String>()
    let uniqueCandidates = candidates.filter { candidate in
      if seen.contains(candidate) {
        return false
      }
      seen.insert(candidate)
      return true
    }

    return uniqueCandidates.isEmpty ? nil : uniqueCandidates.joined(separator: " · ")
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
    case .approval:
      return "No approvals are waiting."
    case .blocked:
      return "Nothing is blocked right now."
    case .diagnostics:
      return "No diagnostic tasks are waiting."
    case .active:
      return "No PRDs are actively executing."
    case .queued:
      return "No PRDs are waiting in this Ralph home."
    case .completed:
      return "No recent completed PRDs in the current history window. Total completed: \(store.snapshot.totalCompletedCount)."
    }
  }
}

struct PrdInventorySectionView: View {
  let title: String
  let subtitle: String
  let items: [PrdInventoryItem]
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

      ForEach(items) { item in
        PrdInventoryRow(item: item, store: store)
      }
    }
  }
}

struct PrdInventoryRow: View {
  let item: PrdInventoryItem
  @ObservedObject var store: SnapshotStore
  @State private var isExpanded = false

  var body: some View {
    Button {
      withAnimation(.easeInOut(duration: 0.16)) {
        isExpanded.toggle()
      }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(inventoryStatusLabel)
            .font(.system(size: 10, weight: .semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(
              Capsule(style: .continuous)
                .fill(inventoryTint.opacity(0.14))
            )
            .foregroundStyle(inventoryTint)

          Text(item.title ?? item.prdId ?? pathStem(item.path) ?? item.path)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(isExpanded ? 3 : 1)
            .truncationMode(.tail)

          Spacer()

          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
        }

        if isExpanded {
          Text(abbreviatedPath(item.path))
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .truncationMode(.middle)

          HStack(spacing: 8) {
            Button("Open PRD") {
              store.openPath(item.path)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button("Open Folder") {
              store.openPath(URL(fileURLWithPath: item.path).deletingLastPathComponent().path)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
          }
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Color.primary.opacity(0.035))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }

  private var inventoryStatusLabel: String {
    switch item.status {
    case "changed_since_ingested":
      return "Changed"
    case "not_ingested":
      return "Not queued"
    default:
      return item.status.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  private var inventoryTint: Color {
    item.status == "changed_since_ingested" ? .orange : .gray
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

struct StoryStripView: View {
  let stories: [StoryProgress]

  var body: some View {
    HStack(spacing: 3) {
      ForEach(Array(stories.enumerated()), id: \.offset) { _, story in
        Capsule(style: .continuous)
          .fill(storyColor(story.status))
          .frame(width: 18, height: 5)
          .help(storyStatusLabel(story))
      }
    }
    .frame(height: 8)
  }

  private func storyColor(_ status: String?) -> Color {
    switch status ?? "" {
    case "passed":
      return .green
    case "in_progress":
      return .blue
    case "needs_repair":
      return .orange
    case "failed":
      return .red
    case "pending":
      return .gray.opacity(0.55)
    default:
      return .secondary.opacity(0.5)
    }
  }
}

struct TaskRowView: View {
  let task: TaskState
  let style: TaskSectionStyle
  @ObservedObject var store: SnapshotStore
  @State private var isExpanded = false

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(accentColor)
        .frame(width: 4)

      VStack(alignment: .leading, spacing: isExpanded ? 10 : 8) {
        summaryButton

        if isExpanded {
          expandedDetails
            .transition(.opacity.combined(with: .move(edge: .top)))
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
    .animation(.easeInOut(duration: 0.16), value: isExpanded)
  }

  private var summaryButton: some View {
    Button {
      withAnimation(.easeInOut(duration: 0.16)) {
        isExpanded.toggle()
      }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if store.shouldShowRepoBadge(for: task.repoPath) {
            Text(shortRepoName(task.repoPath))
              .font(.system(size: 11, weight: .semibold))
              .padding(.horizontal, 8)
              .padding(.vertical, 4)
              .background(
                Capsule(style: .continuous)
                  .fill(Color.primary.opacity(0.07))
              )
          }

          StatusChip(task: task)

          Spacer()

          Text(relativeTimestamp(task.updatedAt))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)

          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
        }

        Text(shortTitle(task))
          .font(.system(size: style == .completed ? 13 : 14, weight: .semibold))
          .foregroundStyle(.primary)
          .lineLimit(isExpanded ? 3 : 1)
          .truncationMode(.tail)
          .fixedSize(horizontal: false, vertical: true)

        if let summary = compactSummary {
          HStack(alignment: .top, spacing: 6) {
            Image(systemName: stageSymbol)
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(stageTint)
              .frame(width: 12, height: 12)

            Text(summary)
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(isBlockStyle(style) ? .orange : .secondary)
              .lineLimit(isExpanded ? 2 : 1)
              .truncationMode(.tail)
          }
        }
      }
      .contentShape(Rectangle())
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain)
  }

  private var expandedDetails: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let prd = prdIdentity(task) {
        HStack(spacing: 5) {
          Image(systemName: "doc.text")
            .font(.system(size: 10, weight: .semibold))
          Text(prd)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .foregroundStyle(.secondary)
      }

      if let summary = storySummary(task) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            if let stories = task.storyProgress, !stories.isEmpty {
              StoryStripView(stories: stories)
            }

            Text(summary)
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(.secondary)
          }

          let counts = storyCounts(task)
          if counts.total > 0 {
            ProgressView(value: Double(counts.completed), total: Double(counts.total))
              .progressViewStyle(.linear)
              .tint(accentColor)
          }
        }
      }

      if let stageSummary = taskStageSummary(task) {
        detailLine(
          systemImage: stageSymbol,
          text: stageSummary,
          tint: stageTint,
          foreground: isBlockStyle(style) ? .orange : .secondary
        )
      }

      if let recoverySummary = autoRecoverySummary(task) {
        detailLine(
          systemImage: task.autoRecovery?.reason == "cooldown" ? "timer" : "arrow.clockwise",
          text: recoverySummary,
          tint: .blue,
          foreground: .blue
        )
      }

      if let errorSnippet = secondaryErrorSnippet {
        Text(errorSnippet)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(isBlockStyle(style) ? .orange : .secondary)
          .lineLimit(3)
      }

      actionRow
    }
  }

  private func detailLine(systemImage: String, text: String, tint: Color, foreground: Color) -> some View {
    HStack(alignment: .top, spacing: 6) {
      Image(systemName: systemImage)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 12, height: 12)

      Text(text)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(foreground)
        .lineLimit(3)
    }
  }

  private var actionRow: some View {
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

  private var compactSummary: String? {
    let candidates = [
      storySummary(task),
      taskStageSummary(task),
      secondaryErrorSnippet,
    ].compactMap { $0 }

    var seen = Set<String>()
    let uniqueCandidates = candidates.filter { candidate in
      if seen.contains(candidate) {
        return false
      }
      seen.insert(candidate)
      return true
    }

    return uniqueCandidates.isEmpty ? nil : uniqueCandidates.joined(separator: " · ")
  }

  private var accentColor: Color {
    switch style {
    case .active:
      return .blue
    case .queued:
      return .gray
    case .approval, .blocked, .diagnostics:
      return .orange
    case .completed:
      return .green
    }
  }

  private var stageSymbol: String {
    if isRecoveryPlanningTask(task) {
      return "doc.badge.plus"
    }

    if isMergeRepairTask(task) {
      return "arrow.triangle.merge"
    }

    if isAutoRecovering(task) {
      return task.autoRecovery?.reason == "cooldown" ? "timer" : "arrow.clockwise"
    }

    switch task.status {
    case "pending":
      return "clock"
    case "running":
      return "bolt.fill"
    case "ready_to_finalize", "finalizing":
      return "arrow.triangle.merge"
    case "completed":
      return "checkmark.circle.fill"
    case "failed", "failed_finalize", "stagnant":
      return "exclamationmark.triangle.fill"
    default:
      return "info.circle"
    }
  }

  private var stageTint: Color {
    switch style {
    case .active:
      return .blue
    case .queued:
      return .gray
    case .approval, .blocked, .diagnostics:
      return .orange
    case .completed:
      return .green
    }
  }

  private var secondaryErrorSnippet: String? {
    guard let errorSnippet = taskErrorSnippet(task) else {
      return nil
    }
    if errorSnippet == taskStageSummary(task) {
      return nil
    }
    return errorSnippet
  }

  private var primaryAction: (title: String, systemImage: String, action: () -> Void)? {
    if isRecoveryPlanningTask(task) {
      if task.prdPath != nil {
        return ("Open PRD", "doc.text", { store.openPath(task.prdPath) })
      }
      return ("Open Worktree", "shippingbox", { store.openPath(task.worktree) })
    }

    if isMergeRepairTask(task) {
      return ("Open Worktree", "shippingbox", { store.openPath(task.worktree) })
    }

    if isAutoRecovering(task) {
      return ("Open Worktree", "shippingbox", { store.openPath(task.worktree) })
    }

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
    if isRecoveryPlanningTask(task) {
      return .gray
    }

    if isMergeRepairTask(task) {
      if task.autoRecovery?.reason == "cooldown" {
        return .gray
      }
      if task.status == "failed" || task.status == "failed_finalize" || task.status == "stagnant" {
        return .orange
      }
      return .blue
    }

    if isAutoRecovering(task) {
      return task.autoRecovery?.reason == "cooldown" ? .gray : .blue
    }

    if isBlockedCompletion(task) {
      return .orange
    }

    if isTargetSyncFailed(task) || isTargetSyncPending(task) {
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
