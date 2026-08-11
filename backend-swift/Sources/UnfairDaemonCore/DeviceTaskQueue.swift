import Foundation

protocol DeviceTaskScheduling: AnyObject {
    func async(_ work: @escaping @Sendable () -> Void)
}

/// The device-local IPA pipeline is intentionally serial. Downloading, SINF
/// injection and process dumping all compete for the same constrained memory,
/// storage and app-installation resources on iOS.
final class DeviceTaskQueue: DeviceTaskScheduling {
    static let shared = DeviceTaskQueue()

    private let queue: DispatchQueue

    init(label: String = "wiki.qaq.unfaird.device-task-queue") {
        queue = DispatchQueue(label: label, qos: .utility)
    }

    func async(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }
}
