import Foundation

final class BundleTaskGate {
    final class Lease {
        private let lock = NSLock()
        private var releaseAction: (() -> Void)?

        fileprivate init(release: @escaping () -> Void) {
            releaseAction = release
        }

        func release() {
            lock.lock()
            let action = releaseAction
            releaseAction = nil
            lock.unlock()
            action?()
        }

        deinit {
            release()
        }
    }

    static let shared = BundleTaskGate()

    private let lock = NSLock()
    private var activeBundleIDs: Set<String> = []

    func tryAcquire(bundleID: String) -> Lease? {
        lock.lock()
        guard activeBundleIDs.insert(bundleID).inserted else {
            lock.unlock()
            return nil
        }
        lock.unlock()
        return Lease { [weak self] in
            self?.lock.lock()
            self?.activeBundleIDs.remove(bundleID)
            self?.lock.unlock()
        }
    }
}
