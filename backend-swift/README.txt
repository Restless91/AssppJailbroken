unfaird

Local HTTP service for IPA processing.

macOS build:
  swift build

macOS run:
  swift run UnfairDaemon serve

macOS launchd install:
  make mac-install
  make mac-uninstall

iOS requirements:
  Theos, iPhoneOS SDK, ldid, libjailbreak.dylib

libjailbreak paths:
  /var/jb/usr/lib/libjailbreak.dylib
  /var/jb/basebin/libjailbreak.dylib
  /basebin/libjailbreak.dylib

Complete rootless iOS deb from the AssppWeb repository root:
  cd ..
  make build

Install on device:
  apt install ./wiki.qaq.unfaird_<version>_iphoneos-arm64.deb

iOS deployment guide:
  docs/deploy-ios.md

launchd service:
  launchctl print system/wiki.qaq.unfaird
  launchctl bootout system/wiki.qaq.unfaird

Health:
  curl -I http://127.0.0.1:8080/
  curl http://127.0.0.1:8080/health

Decrypt:
  curl -sS -F "ipa=@/path/to/app.ipa" http://127.0.0.1:8080/api/v1/decrypt

Ready:
  curl -sS http://127.0.0.1:8080/api/v1/decrypt/<job-id>/ready

Download after ready is true:
  curl -L -o output.ipa http://127.0.0.1:8080/api/v1/decrypt/<job-id>/output

Client helper:
  ./unfair.sh 127.0.0.1 /path/to/app.ipa ./output.ipa

CLI help:
  swift run UnfairDaemon --help

Use this project only with IPAs you own or have permission to analyze.
