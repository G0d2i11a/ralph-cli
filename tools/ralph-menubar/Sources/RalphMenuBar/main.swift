import AppKit
import Combine
import Darwin
import SwiftUI

private var instanceLockFileDescriptor: CInt = -1

final class RalphMenuBarAppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem?
  private let store = SnapshotStore()
  private let popover = NSPopover()
  private var refreshTimer: Timer?
  private var cancellables = Set<AnyCancellable>()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem?.button {
      button.target = self
      button.action = #selector(togglePopover(_:))
      button.imagePosition = .imageLeading
      button.image = BrandIcon.statusTemplateImage()
      button.font = .systemFont(ofSize: 12, weight: .semibold)
      button.title = ""
    }

    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 540, height: 720)
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
    releaseSingleInstanceLock()
  }

  @objc private func togglePopover(_ sender: Any?) {
    guard let button = statusItem?.button else { return }

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
    guard let button = statusItem?.button else { return }

    let actions = store.snapshot.actionCount
    let executing = store.snapshot.executionCount
    let hasStaleManager = store.snapshot.managerIsStale
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
    let selectedSnapshot = store.snapshot
    let selectedManagerLabel = selectedSnapshot.managerState
      .map { "\($0.status ?? "unknown") / \(shortRepoName($0.repo))" }
      ?? "missing"

    var lines = [
      "Selected: \(store.selectedProjectName)",
      "Executing: \(selectedSnapshot.executionCount)",
      "Repairing: \(selectedSnapshot.recoveringCount)",
      "Planning: \(selectedSnapshot.planningCount)",
      "Waiting: \(selectedSnapshot.waitingRecoveryCount)",
      "Queued: \(selectedSnapshot.queuedCount)",
      "Approval/blocked: \(selectedSnapshot.actionCount)",
      "Recent completed: \(selectedSnapshot.recentCompletedCount)",
      "Total completed: \(selectedSnapshot.totalCompletedCount)",
      "Manager: \(selectedManagerLabel)",
      "",
      "All registered projects: \(store.projectSnapshots.count)"
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

func shouldTerminateDuplicateInstance() -> Bool {
  let currentPID = ProcessInfo.processInfo.processIdentifier
  let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.g0d2i11a.ralph.menubar"
  let earlierInstance = NSRunningApplication
    .runningApplications(withBundleIdentifier: bundleIdentifier)
    .first { !$0.isTerminated && $0.processIdentifier < currentPID }

  if let earlierInstance {
    earlierInstance.activate(options: [])
    return true
  }

  return false
}

func acquireSingleInstanceLock() -> Bool {
  let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/RalphMenuBar", isDirectory: true)

  do {
    try FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
  } catch {
    return true
  }

  let lockPath = supportDirectory.appendingPathComponent("RalphMenuBar.lock").path
  let descriptor = Darwin.open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
  guard descriptor >= 0 else {
    return true
  }

  if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
    Darwin.close(descriptor)
    return false
  }

  instanceLockFileDescriptor = descriptor
  let pid = "\(ProcessInfo.processInfo.processIdentifier)\n"
  _ = ftruncate(descriptor, 0)
  pid.withCString { pointer in
    _ = write(descriptor, pointer, strlen(pointer))
  }
  return true
}

func releaseSingleInstanceLock() {
  guard instanceLockFileDescriptor >= 0 else { return }
  _ = flock(instanceLockFileDescriptor, LOCK_UN)
  Darwin.close(instanceLockFileDescriptor)
  instanceLockFileDescriptor = -1
}

let app = NSApplication.shared
var delegate: RalphMenuBarAppDelegate?

if !acquireSingleInstanceLock() || shouldTerminateDuplicateInstance() {
  exit(EXIT_SUCCESS)
} else {
  let appDelegate = RalphMenuBarAppDelegate()
  delegate = appDelegate
  app.delegate = appDelegate
  app.run()
}
