import Darwin
import Dispatch
import Foundation
import Vapor

struct PosixSpawnResult {
    let exitCode: Int32
    let stdout: Data
    let stderr: Data

    var stdoutString: String {
        String(data: stdout, encoding: .utf8) ?? stdout.base64EncodedString()
    }

    var stderrString: String {
        String(data: stderr, encoding: .utf8) ?? stderr.base64EncodedString()
    }
}

final class PosixSpawnCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

enum PosixSpawn {
    enum OutputStream {
        case stdout
        case stderr
    }

    static func run(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL,
        sandboxProfileURL: URL? = nil,
        timeoutSeconds: Int? = nil,
        cancellation: PosixSpawnCancellation? = nil,
        onOutputLine: ((OutputStream, String) -> Void)? = nil
    ) throws -> PosixSpawnResult {
        var stdoutPipe = try makePipe(operation: "stdout pipe")
        var stderrPipe = try makePipe(operation: "stderr pipe")
        defer {
            closeIfOpen(&stdoutPipe.read)
            closeIfOpen(&stdoutPipe.write)
            closeIfOpen(&stderrPipe.read)
            closeIfOpen(&stderrPipe.write)
        }

        let launch = launchCommand(
            executablePath: executablePath,
            arguments: arguments,
            sandboxProfileURL: sandboxProfileURL
        )

        var actions: posix_spawn_file_actions_t?
        try throwIfFailed(posix_spawn_file_actions_init(&actions), operation: "posix_spawn_file_actions_init")
        defer { posix_spawn_file_actions_destroy(&actions) }

        #if !os(iOS)
        try throwIfFailed(posix_spawn_file_actions_addchdir_np(&actions, workingDirectory.path), operation: "posix_spawn_file_actions_addchdir_np")
        #endif
        try throwIfFailed(posix_spawn_file_actions_adddup2(&actions, stdoutPipe.write, STDOUT_FILENO), operation: "stdout redirect")
        try throwIfFailed(posix_spawn_file_actions_adddup2(&actions, stderrPipe.write, STDERR_FILENO), operation: "stderr redirect")
        try throwIfFailed(posix_spawn_file_actions_addclose(&actions, stdoutPipe.read), operation: "stdout read close")
        try throwIfFailed(posix_spawn_file_actions_addclose(&actions, stderrPipe.read), operation: "stderr read close")
        try throwIfFailed(posix_spawn_file_actions_addclose(&actions, stdoutPipe.write), operation: "stdout write close")
        try throwIfFailed(posix_spawn_file_actions_addclose(&actions, stderrPipe.write), operation: "stderr write close")

        var attributes: posix_spawnattr_t?
        try throwIfFailed(posix_spawnattr_init(&attributes), operation: "posix_spawnattr_init")
        defer { posix_spawnattr_destroy(&attributes) }
        try throwIfFailed(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)), operation: "posix_spawnattr_setflags")
        try throwIfFailed(posix_spawnattr_setpgroup(&attributes, 0), operation: "posix_spawnattr_setpgroup")

        let rawArguments = ([launch.executablePath] + launch.arguments).map { strdup($0) }
        defer {
            for pointer in rawArguments {
                free(pointer)
            }
        }
        var argv = rawArguments + [nil]

        var pid: pid_t = 0

        #if os(iOS)
        try spawnFromWorkingDirectory(
            workingDirectory,
            pid: &pid,
            executablePath: launch.executablePath,
            actions: &actions,
            attributes: &attributes,
            argv: &argv
        )
        #else
        let spawnStatus = posix_spawn(&pid, launch.executablePath, &actions, &attributes, &argv, nil)
        try throwIfFailed(spawnStatus, operation: "posix_spawn \(launch.executablePath)")
        #endif

        closeIfOpen(&stdoutPipe.write)
        closeIfOpen(&stderrPipe.write)

        let group = DispatchGroup()
        let outputQueue = DispatchQueue.global(qos: .utility)
        var stdout = Data()
        var stderr = Data()
        var stdoutError: Error?
        var stderrError: Error?

        group.enter()
        outputQueue.async {
            do {
                stdout = try readOutputPipe(stdoutPipe.read, stream: .stdout, onOutputLine: onOutputLine)
            } catch {
                stdoutError = error
            }
            group.leave()
        }

        group.enter()
        outputQueue.async {
            do {
                stderr = try readOutputPipe(stderrPipe.read, stream: .stderr, onOutputLine: onOutputLine)
            } catch {
                stderrError = error
            }
            group.leave()
        }

        let waitStatus: Int32
        var waitError: Error?
        do {
            waitStatus = try wait(for: pid, timeoutSeconds: timeoutSeconds, cancellation: cancellation)
        } catch {
            waitError = error
            waitStatus = 0
        }

        group.wait()
        closeIfOpen(&stdoutPipe.read)
        closeIfOpen(&stderrPipe.read)

        if let waitError = waitError {
            throw waitError
        }
        if let stdoutError = stdoutError {
            throw stdoutError
        }
        if let stderrError = stderrError {
            throw stderrError
        }
        return PosixSpawnResult(exitCode: exitCode(from: waitStatus), stdout: stdout, stderr: stderr)
    }

    #if os(iOS)
    private static func spawnFromWorkingDirectory(
        _ workingDirectory: URL,
        pid: inout pid_t,
        executablePath: String,
        actions: inout posix_spawn_file_actions_t?,
        attributes: inout posix_spawnattr_t?,
        argv: inout [UnsafeMutablePointer<CChar>?]
    ) throws {
        try ProcessWorkingDirectory.withCurrentDirectory(workingDirectory) {
            let spawnStatus = posix_spawn(&pid, executablePath, &actions, &attributes, &argv, nil)
            try throwIfFailed(spawnStatus, operation: "posix_spawn \(executablePath)")
        }
    }
    #endif

    private static func launchCommand(
        executablePath: String,
        arguments: [String],
        sandboxProfileURL: URL?
    ) -> (executablePath: String, arguments: [String]) {
        guard let sandboxProfileURL = sandboxProfileURL else {
            return (executablePath, arguments)
        }
        return (
            PackageRunnerSandbox.sandboxExecPath,
            ["-f", sandboxProfileURL.path, executablePath] + arguments
        )
    }

    private static func throwIfFailed(_ status: Int32, operation: String) throws {
        guard status == 0 else {
            throw Abort(.internalServerError, reason: "\(operation) failed: \(String(cString: strerror(status)))")
        }
    }

    private static func throwIfErrnoFailed(_ status: Int32, operation: String) throws {
        guard status == 0 else {
            throw Abort(.internalServerError, reason: "\(operation) failed: \(String(cString: strerror(errno)))")
        }
    }

    private static func makePipe(operation: String) throws -> (read: Int32, write: Int32) {
        var fds = [Int32](repeating: -1, count: 2)
        let status = fds.withUnsafeMutableBufferPointer { buffer in
            pipe(buffer.baseAddress!)
        }
        try throwIfErrnoFailed(status, operation: operation)
        return (fds[0], fds[1])
    }

    private static func closeIfOpen(_ fd: inout Int32) {
        guard fd >= 0 else {
            return
        }
        close(fd)
        fd = -1
    }

    private static func readOutputPipe(
        _ fd: Int32,
        stream: OutputStream,
        onOutputLine: ((OutputStream, String) -> Void)?
    ) throws -> Data {
        var output = Data()
        var pendingLine = ""
        var buffer = [UInt8](repeating: 0, count: 4096)

        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count > 0 {
                let chunk = Data(buffer[0..<count])
                output.append(chunk)
                emitCompleteLines(from: chunk, pendingLine: &pendingLine, stream: stream, onOutputLine: onOutputLine)
                continue
            }
            if count == 0 {
                emitPendingLine(pendingLine, stream: stream, onOutputLine: onOutputLine)
                return output
            }
            if errno == EINTR {
                continue
            }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func emitCompleteLines(
        from chunk: Data,
        pendingLine: inout String,
        stream: OutputStream,
        onOutputLine: ((OutputStream, String) -> Void)?
    ) {
        guard let onOutputLine = onOutputLine else {
            return
        }

        pendingLine += String(decoding: chunk, as: UTF8.self)
        let parts = pendingLine.components(separatedBy: .newlines)
        let endedWithNewline = pendingLine.unicodeScalars.last.map { CharacterSet.newlines.contains($0) } ?? false
        let completeLines = endedWithNewline ? parts : Array(parts.dropLast())

        for line in completeLines {
            emitPendingLine(line, stream: stream, onOutputLine: onOutputLine)
        }
        pendingLine = endedWithNewline ? "" : parts.last ?? ""
    }

    private static func emitPendingLine(
        _ line: String,
        stream: OutputStream,
        onOutputLine: ((OutputStream, String) -> Void)?
    ) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else {
            return
        }
        onOutputLine?(stream, trimmed)
    }

    private static func wait(
        for pid: pid_t,
        timeoutSeconds: Int?,
        cancellation: PosixSpawnCancellation?
    ) throws -> Int32 {
        var waitStatus: Int32 = 0
        guard timeoutSeconds != nil || cancellation != nil else {
            while waitpid(pid, &waitStatus, 0) == -1 {
                if errno == EINTR {
                    continue
                }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            return waitStatus
        }

        let deadline = timeoutSeconds.map { Date().addingTimeInterval(TimeInterval($0)) }
        while true {
            let result = waitpid(pid, &waitStatus, WNOHANG)
            if result == pid {
                return waitStatus
            }
            if result == -1 {
                if errno == EINTR {
                    continue
                }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            if cancellation?.isCancelled == true {
                kill(-pid, SIGKILL)
                _ = waitpid(pid, &waitStatus, 0)
                throw Abort(.conflict, reason: "decrypt cancelled")
            }
            if let deadline, Date() >= deadline {
                kill(-pid, SIGKILL)
                _ = waitpid(pid, &waitStatus, 0)
                throw Abort(.requestTimeout, reason: "decrypt timed out after \(timeoutSeconds ?? 0) seconds")
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private static func exitCode(from waitStatus: Int32) -> Int32 {
        let status = waitStatus & 0x7f
        if status == 0 {
            return (waitStatus >> 8) & 0xff
        }
        if status != 0x7f {
            return 128 + status
        }
        return waitStatus
    }
}
