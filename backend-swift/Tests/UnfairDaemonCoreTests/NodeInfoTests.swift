import XCTest
@testable import UnfairDaemonCore

final class NodeInfoTests: XCTestCase {
    func testAppinstCandidatesPreferStablePathsBeforeRootHideNamespace() {
        XCTAssertEqual(
            appinstCandidatePaths(
                executablePath: "/var/containers/Bundle/Application/.jbroot-ABC123/var/jb/usr/local/lib/unfaird/UnfairDaemon"
            ),
            [
                "/var/jb/usr/bin/appinst",
                "/usr/bin/appinst",
                "/bin/appinst",
                "/var/containers/Bundle/Application/.jbroot-ABC123/usr/bin/appinst",
                "/var/containers/Bundle/Application/.jbroot-ABC123/var/jb/usr/bin/appinst",
            ]
        )
    }

    func testRootHideInstallCapabilitiesExposeAppinstAndTrollStoreWhenAvailable() {
        let capabilities = installCapabilities(
            executablePath: "/var/containers/Bundle/Application/.jbroot-ABC123/var/jb/usr/local/lib/unfaird/UnfairDaemon",
            runtime: "RootHide/Dopamine",
            isExecutable: { path in
                path.contains("TrollStoreLite.app/trollstorehelper")
                    || path.hasSuffix("/usr/bin/appinst")
            }
        )

        XCTAssertTrue(capabilities.appinst)
        XCTAssertTrue(capabilities.trollStore)
    }

    func testRootlessInstallCapabilitiesUseAppinstOnly() {
        let capabilities = installCapabilities(
            executablePath: "/var/jb/usr/local/lib/unfaird/UnfairDaemon",
            runtime: "Dopamine/rootless",
            isExecutable: { path in
                path == "/var/jb/usr/bin/appinst"
            }
        )

        XCTAssertTrue(capabilities.appinst)
        XCTAssertFalse(capabilities.trollStore)
    }

    func testRuntimeDetectionPrefersRootHideExecutableNamespace() {
        XCTAssertEqual(
            detectJailbreakRuntime(
                executablePath: "/var/containers/Bundle/Application/.jbroot-ABC123/var/jb/usr/local/lib/unfaird/UnfairDaemon",
                pathExists: { $0 == "/var/jb/basebin/jailbreakd" }
            ),
            "RootHide/Dopamine"
        )
    }
}
