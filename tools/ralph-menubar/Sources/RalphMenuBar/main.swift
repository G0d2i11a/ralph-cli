import AppKit
import Combine
import SwiftUI

final class RalphMenuBarAppDelegate: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let store = SnapshotStore()
  private let popover = NSPopover()
  private var refreshTimer: Timer?
  private var cancellables = Set<AnyCancellable>()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    if let button = statusItem.button {
      button.target = self
      button.action = #selector(togglePopover(_:))
      button.imagePosition = .imageLeading
      button.image = BrandIcon.statusTemplateImage()
      button.font = .systemFont(ofSize: 12, weight: .semibold)
      button.title = ""
    }

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 468, height: 620)
    popover.contentViewController = NSHostingController(rootView: RalphMenuBarView(store: store))

    store.$snapshot
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        self?.updateStatusButton()
      }
      .store(in: &cancellables)

    store.$projectSnapshots
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        self?.updateStatusButton()
      }
      .store(in: &cancellables)

    store.$config
      .receive(on: RunLoop.main)
      .sink { [weak self] config in
        self?.restartTimer(with: max(config.refreshSeconds, 2))
      }
      .store(in: &cancellables)

    store.refresh()
  }

  func applicationWillTerminate(_ notification: Notification) {
    refreshTimer?.invalidate()
  }

  @objc private func togglePopover(_ sender: Any?) {
    guard let button = statusItem.button else { return }

    if popover.isShown {
      popover.performClose(sender)
      return
    }

    store.refresh()
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func restartTimer(with interval: TimeInterval) {
    refreshTimer?.invalidate()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      self?.store.refresh()
    }
    if let refreshTimer {
      RunLoop.main.add(refreshTimer, forMode: .common)
    }
  }

  private func updateStatusButton() {
    guard let button = statusItem.button else { return }

    let actions = store.totalActionCount
    let executing = store.totalExecutionCount
    let hasStaleManager = store.projectSnapshots.contains { $0.snapshot.managerIsStale }
    let title: String

    if hasStaleManager {
      title = actions > 0 ? "\(actions)" : ""
    } else if actions > 0 {
      title = "\(actions)"
    } else if executing > 0 {
      title = "\(executing)"
    } else {
      title = ""
    }

    button.image = BrandIcon.statusTemplateImage()
    button.contentTintColor = nil
    button.title = title
    button.toolTip = tooltip()
  }

  private func tooltip() -> String {
    var lines = [
      "Ralph projects: \(store.projectSnapshots.count)",
      "Executing: \(store.totalExecutionCount)",
      "Repairing: \(store.totalRecoveringCount)",
      "Planning: \(store.totalPlanningCount)",
      "Waiting: \(store.totalWaitingRecoveryCount)",
      "Queued: \(store.totalQueuedCount)",
      "Approval/blocked: \(store.totalActionCount)",
      "Recent completed: \(store.totalRecentCompletedCount)",
      "Total completed: \(store.totalCompletedCount)"
    ]

    for projectSnapshot in store.projectSnapshots {
      let snapshot = projectSnapshot.snapshot
      let managerLabel = snapshot.managerState
        .map { "\($0.status ?? "unknown") / \(shortRepoName($0.repo))" }
        ?? "missing"

      lines.append("\(projectSnapshot.project.name): \(snapshot.executionCount) executing, \(snapshot.recoveringCount) repairing, \(snapshot.planningCount) planning, \(snapshot.waitingRecoveryCount) waiting, \(snapshot.queuedCount) queued, \(snapshot.actionCount) approval/blocked, \(snapshot.recentCompletedCount) recent completed, \(snapshot.totalCompletedCount) total completed, manager \(managerLabel)")
    }

    return lines.joined(separator: "\n")
  }
}

let app = NSApplication.shared
let delegate = RalphMenuBarAppDelegate()
app.delegate = delegate
app.run()
