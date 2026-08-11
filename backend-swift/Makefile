SHELL := /bin/bash

DEVICE_HOST ?=
DEVICE_PROFILE ?= rootless
THEOS ?= $(HOME)/theos
THEOS_PACKAGE_SCHEME ?= rootless
THEOS_PACKAGE_DIR_NAME ?= debs
ARCHS := arm64

ifeq ($(DEVICE_PROFILE),taurine)
override THEOS_PACKAGE_SCHEME :=
override THEOS_PACKAGE_ARCH := iphoneos-arm
TARGET := iphone:clang:latest:15.0
IOS_TARGET := arm64-apple-ios15.0
else
TARGET := iphone:clang:latest:15.0
IOS_TARGET := arm64-apple-ios15.0
endif

PACKAGE_NAME := wiki.qaq.unfaird
EXECUTABLE_NAME := UnfairDaemon
BUILD_INFO := Sources/UnfairDaemonCore/BuildInfo.swift
IOS_BUILD_DIR := .build/ios-release
ASSPPWEB_DIR ?= ..
ASSPPWEB_FRONTEND_DIST := $(ASSPPWEB_DIR)/frontend/dist
IPHONEOS_SDK_PATH := $(shell xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)
LDID ?= $(shell command -v ldid 2>/dev/null)
ifeq ($(LDID),)
LDID := $(THEOS)/bin/ldid
endif
SWIFT_STDLIB_TOOL ?= $(shell xcrun --find swift-stdlib-tool 2>/dev/null)
SWIFT_55_IPHONEOS_LIB_DIR ?= $(shell dirname "$$(xcrun --find swiftc 2>/dev/null)")/../lib/swift-5.5/iphoneos
TAURINE_RUNTIME_RUNNER ?=
TAURINE_RUNTIME_DUMPER ?=

IOS_SWIFT_FLAGS := --triple $(IOS_TARGET) --sdk "$(IPHONEOS_SDK_PATH)"

.PHONY: all build release ios-release assppweb-frontend mac-install mac-uninstall generate-build-info clean-package

all:: ios-release

build:
	@set -euo pipefail; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	restore() { cp "$$original" "$(BUILD_INFO)"; rm -f "$$original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	swift build

release:
	@set -euo pipefail; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	restore() { cp "$$original" "$(BUILD_INFO)"; rm -f "$$original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	swift build -c release

mac-install: release
	bash deploy/install-launchdaemon.sh

mac-uninstall:
	bash deploy/uninstall-launchdaemon.sh

ios-release:
	@set -euo pipefail; \
	if [[ -z "$(IPHONEOS_SDK_PATH)" ]]; then echo "iphoneos SDK missing" >&2; exit 1; fi; \
	if [[ ! -x "$(LDID)" ]]; then echo "ldid missing: $(LDID)" >&2; exit 1; fi; \
	if [[ ! -x "$(SWIFT_STDLIB_TOOL)" ]]; then echo "swift-stdlib-tool missing: $(SWIFT_STDLIB_TOOL)" >&2; exit 1; fi; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	restore() { cp "$$original" "$(BUILD_INFO)"; rm -f "$$original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	bin_dir="$$(swift build -c release --product "$(EXECUTABLE_NAME)" --show-bin-path $(IOS_SWIFT_FLAGS))"; \
	swift build -c release --product "$(EXECUTABLE_NAME)" $(IOS_SWIFT_FLAGS); \
	rm -rf "$(IOS_BUILD_DIR)"; \
	install -d "$(IOS_BUILD_DIR)"; \
	install -m 0755 "$$bin_dir/$(EXECUTABLE_NAME)" "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)"; \
	"$(SWIFT_STDLIB_TOOL)" --copy --scan-executable "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" --destination "$(IOS_BUILD_DIR)" --platform iphoneos; \
	"$(LDID)" -Spackaging/unfaird.entitlements "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)"; \
	shopt -s nullglob; \
	for dylib in "$(IOS_BUILD_DIR)"/libswift*.dylib; do "$(LDID)" -S "$$dylib"; done

assppweb-frontend:
	@set -euo pipefail; \
	if [[ ! -d "$(ASSPPWEB_DIR)" ]]; then echo "AssppWeb directory missing: $(ASSPPWEB_DIR)" >&2; exit 1; fi; \
	cd "$(ASSPPWEB_DIR)/frontend"; \
	npm ci; \
	npm run build; \
	cd - >/dev/null; \
	test -f "$(ASSPPWEB_FRONTEND_DIST)/index.html"

generate-build-info:
	@commit="$$(git rev-parse --short=12 HEAD 2>/dev/null || awk -F'\"' '/static let commit/ { print $$2; exit }' "$(BUILD_INFO)" 2>/dev/null || echo unknown)"; \
	if [[ -z "$$commit" ]]; then commit="unknown"; fi; \
	timestamp="$$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
	printf 'enum BuildInfo {\n    static let commit = "%s"\n    static let timestamp = "%s"\n}\n' "$$commit" "$$timestamp" > "$(BUILD_INFO)"

clean-package:
	rm -rf "$(IOS_BUILD_DIR)" ".theos"
	@echo "Preserved versioned release packages in $(THEOS_PACKAGE_DIR_NAME)"

THEOS_GOALS := package stage install show uninstall before-stage internal-stage after-stage before-package internal-package after-package
ifneq ($(filter $(THEOS_GOALS),$(MAKECMDGOALS)),)
include $(THEOS)/makefiles/common.mk
include $(THEOS_MAKE_PATH)/rules.mk

after-stage:: ios-release assppweb-frontend
	@set -euo pipefail; \
	prefix="$(THEOS_PACKAGE_INSTALL_PREFIX)"; \
	package_runner=""; \
	if [[ -n "$$prefix" ]]; then \
		dyld_library_path="$$prefix/usr/lib:$$prefix/basebin:/usr/lib:/basebin"; \
		launchd_path="$$prefix/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin"; \
	else \
		dyld_library_path="/usr/lib:/basebin"; \
		launchd_path="/usr/bin:/bin:/usr/sbin:/sbin"; \
	fi; \
	install -d "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(EXECUTABLE_NAME)"; \
	if [[ "$(DEVICE_PROFILE)" == "taurine" ]]; then \
		if [[ ! -x "$(TAURINE_RUNTIME_RUNNER)" ]]; then echo "Taurine runtime runner missing or not executable: $(TAURINE_RUNTIME_RUNNER)" >&2; exit 1; fi; \
		if [[ ! -f "$(TAURINE_RUNTIME_DUMPER)" ]]; then echo "Taurine runtime dumper missing: $(TAURINE_RUNTIME_DUMPER)" >&2; exit 1; fi; \
		package_runner="/usr/local/lib/unfaird/UnfairRuntimeRunner"; \
		install -m 0755 "$(TAURINE_RUNTIME_RUNNER)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeRunner"; \
		install -m 0755 "$(TAURINE_RUNTIME_DUMPER)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeDumper.dylib"; \
		"$(LDID)" -Spackaging/unfaird.entitlements "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeRunner"; \
		"$(LDID)" -S "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeDumper.dylib"; \
		install -m 0755 vendor/taurine/fouldecrypt.kernrw "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/fouldecrypt.kernrw"; \
		install -m 0755 vendor/taurine/libkernrw.0.dylib "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/libkernrw.0.dylib"; \
		if [[ ! -f "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" ]]; then \
			echo "Swift 5.5 iPhoneOS concurrency runtime missing" >&2; exit 1; \
		fi; \
		install -d "$(THEOS_STAGING_DIR)/usr/lib/swift"; \
		install -m 0755 "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
		"$(LDID)" -S "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
	fi; \
	shopt -s nullglob; \
	for dylib in "$(IOS_BUILD_DIR)"/libswift*.dylib; do install -m 0755 "$$dylib" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/"; done; \
	install -d "$(THEOS_STAGING_DIR)/usr/bin" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public"; \
	rsync -a --delete "$(ASSPPWEB_FRONTEND_DIST)/" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public/"; \
	install -d "$(THEOS_STAGING_DIR)/Library/LaunchDaemons"; \
	sed \
		-e "s|@INSTALL_PREFIX@|$$prefix|g" \
		-e "s|@DYLD_LIBRARY_PATH@|$$dyld_library_path|g" \
		-e "s|@LAUNCHD_PATH@|$$launchd_path|g" \
		-e "s|@PACKAGE_RUNNER@|$$package_runner|g" \
		packaging/wiki.qaq.unfaird.plist.in > "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"; \
	chmod 0644 "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"
endif
