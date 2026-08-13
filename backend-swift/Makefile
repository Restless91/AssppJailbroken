SHELL := /bin/bash

DEVICE_HOST ?=
THEOS ?= $(HOME)/theos
THEOS_PACKAGE_SCHEME ?= rootless
THEOS_PACKAGE_DIR_NAME ?= debs
TARGET := iphone:clang:latest:15.0
ARCHS := arm64e

PACKAGE_NAME := wiki.qaq.unfaird
EXECUTABLE_NAME := UnfairDaemon
RUNTIME_DUMPER_NAME := UnfairRuntimeDumper.dylib
FRIDA_GADGET_NAME := FridaGadget.dylib
FRIDA_DUMP_SCRIPT_NAME := frida-dump.js
FRIDA_GADGET_VERSION ?= 17.17.0
FRIDA_CORE_VERSION ?= $(FRIDA_GADGET_VERSION)
FRIDA_CORE_ARCH ?= arm64e
FRIDA_CORE_DIR := Sources/CFridaCore
FRIDA_CORE_DEVKIT_URL := https://github.com/frida/frida/releases/download/$(FRIDA_CORE_VERSION)/frida-core-devkit-$(FRIDA_CORE_VERSION)-ios-$(FRIDA_CORE_ARCH).tar.xz
FRIDA_GADGET_PATH ?=
OPAINJECT_NAME := opainject
OPAINJECT_PATH ?=
OPAINJECT_REPOSITORY := https://github.com/opa334/opainject
OPAINJECT_COMMIT := 849bb296ea8bc0643a2966485ea3c3c96ebdcd5b
BUILD_INFO := Sources/UnfairDaemonCore/BuildInfo.swift
IOS_TARGET := arm64e-apple-ios15.0
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

IOS_SWIFT_FLAGS := --triple $(IOS_TARGET) --sdk "$(IPHONEOS_SDK_PATH)"

.PHONY: all build release ios-release assppweb-frontend mac-install mac-uninstall generate-build-info prepare-frida-core clean-package

all:: ios-release

build: prepare-frida-core
	@set -euo pipefail; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	restore() { cp "$$original" "$(BUILD_INFO)"; rm -f "$$original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	swift build

release: prepare-frida-core
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

ios-release: prepare-frida-core
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
		"$(shell xcrun --sdk iphoneos --find clang 2>/dev/null)" -target "$(IOS_TARGET)" -dynamiclib -isysroot "$(IPHONEOS_SDK_PATH)" -o "$(IOS_BUILD_DIR)/$(RUNTIME_DUMPER_NAME)" runtime-dumper/UnfairRuntimeDumper.c; \
		"$(LDID)" -S "$(IOS_BUILD_DIR)/$(RUNTIME_DUMPER_NAME)"; \
		if [[ -n "$(FRIDA_GADGET_PATH)" ]]; then \
			cp "$(FRIDA_GADGET_PATH)" "$(IOS_BUILD_DIR)/$(FRIDA_GADGET_NAME)"; \
		else \
			frida_dir="$$(mktemp -d)"; \
			curl -fsSL -o "$$frida_dir/gadget.xz" "https://github.com/frida/frida/releases/download/$(FRIDA_GADGET_VERSION)/frida-gadget-$(FRIDA_GADGET_VERSION)-ios-universal.dylib.xz"; \
			xz -dk "$$frida_dir/gadget.xz"; \
			mv "$$frida_dir/gadget" "$(IOS_BUILD_DIR)/$(FRIDA_GADGET_NAME)"; \
			rm -rf "$$frida_dir"; \
		fi; \
		"$(LDID)" -S "$(IOS_BUILD_DIR)/$(FRIDA_GADGET_NAME)"; \
		install -m 0644 runtime-dumper/$(FRIDA_DUMP_SCRIPT_NAME) "$(IOS_BUILD_DIR)/$(FRIDA_DUMP_SCRIPT_NAME)"; \
		install -m 0755 runtime-dumper/frida-server-dump.py "$(IOS_BUILD_DIR)/frida-server-dump.py"; \
		install -m 0644 runtime-dumper/frida-server-dump-agent.js "$(IOS_BUILD_DIR)/frida-server-dump-agent.js"; \
	if [[ -n "$(OPAINJECT_PATH)" ]]; then \
		install -m 0755 "$(OPAINJECT_PATH)" "$(IOS_BUILD_DIR)/$(OPAINJECT_NAME)"; \
	else \
		opainject_src="$$(mktemp -d)"; \
		git clone --quiet "$(OPAINJECT_REPOSITORY)" "$$opainject_src"; \
		git -C "$$opainject_src" checkout --quiet "$(OPAINJECT_COMMIT)"; \
		"$(shell xcrun --sdk iphoneos --find clang 2>/dev/null)" -target "$(IOS_TARGET)" -isysroot "$(IPHONEOS_SDK_PATH)" -fobjc-arc -DTHEOS_LEAN_AND_MEAN -include stdint.h -include stdbool.h -framework Foundation \
			"$$opainject_src"/main.m "$$opainject_src"/dyld.m "$$opainject_src"/shellcode_inject.m "$$opainject_src"/rop_inject.m "$$opainject_src"/thread_utils.m "$$opainject_src"/task_utils.m "$$opainject_src"/arm64.m \
			-o "$(IOS_BUILD_DIR)/$(OPAINJECT_NAME)"; \
		"$(LDID)" -S"$$opainject_src/entitlements.plist" "$(IOS_BUILD_DIR)/$(OPAINJECT_NAME)"; \
		rm -rf "$$opainject_src"; \
	fi; \
		"$(SWIFT_STDLIB_TOOL)" --copy --scan-executable "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" --destination "$(IOS_BUILD_DIR)" --platform iphoneos; \
		shopt -s nullglob; \
		rm -f "$(IOS_BUILD_DIR)"/libswift*.dylib; \
		"$(LDID)" -Spackaging/unfaird.entitlements "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)"; \
		"$(LDID)" -S "$(IOS_BUILD_DIR)/$(RUNTIME_DUMPER_NAME)"; \
		"$(LDID)" -S "$(IOS_BUILD_DIR)/$(FRIDA_GADGET_NAME)"

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

prepare-frida-core:
	@set -euo pipefail; \
	if [[ -f "$(FRIDA_CORE_DIR)/lib/libfrida-core.a" && -f "$(FRIDA_CORE_DIR)/include/frida-core.h" ]]; then exit 0; fi; \
	tmp_dir="$$(mktemp -d)"; \
	trap 'rm -rf "$$tmp_dir"' EXIT; \
	curl -fsSL "$(FRIDA_CORE_DEVKIT_URL)" -o "$$tmp_dir/frida-core.tar.xz"; \
	tar -xJf "$$tmp_dir/frida-core.tar.xz" -C "$$tmp_dir"; \
	install -d "$(FRIDA_CORE_DIR)/include" "$(FRIDA_CORE_DIR)/lib"; \
	install -m 0644 "$$tmp_dir/frida-core.h" "$(FRIDA_CORE_DIR)/include/frida-core.h"; \
	install -m 0644 "$$tmp_dir/libfrida-core.a" "$(FRIDA_CORE_DIR)/lib/libfrida-core.a"

clean-package:
	rm -rf "$(IOS_BUILD_DIR)" "$(THEOS_PACKAGE_DIR_NAME)" ".theos"

THEOS_GOALS := package stage install show uninstall before-stage internal-stage after-stage before-package internal-package after-package
ifneq ($(filter $(THEOS_GOALS),$(MAKECMDGOALS)),)
include $(THEOS)/makefiles/common.mk
include $(THEOS_MAKE_PATH)/rules.mk

after-stage:: ios-release assppweb-frontend
	@set -euo pipefail; \
	prefix="$(THEOS_PACKAGE_INSTALL_PREFIX)"; \
	if [[ -n "$$prefix" ]]; then \
		dyld_library_path="$$prefix/usr/lib:$$prefix/basebin:/usr/lib:/basebin"; \
		launchd_path="$$prefix/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin"; \
	else \
		dyld_library_path="/usr/lib:/basebin"; \
		launchd_path="/usr/bin:/bin:/usr/sbin:/sbin"; \
	fi; \
	install -d "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(EXECUTABLE_NAME)"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(RUNTIME_DUMPER_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(RUNTIME_DUMPER_NAME)"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(FRIDA_GADGET_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(FRIDA_GADGET_NAME)"; \
	install -m 0644 "$(IOS_BUILD_DIR)/$(FRIDA_DUMP_SCRIPT_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(FRIDA_DUMP_SCRIPT_NAME)"; \
	install -d "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/runtime-dumper"; \
	install -m 0755 runtime-dumper/frida-server-dump.py "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/runtime-dumper/frida-server-dump.py"; \
	install -m 0644 runtime-dumper/frida-server-dump-agent.js "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/runtime-dumper/frida-server-dump-agent.js"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(OPAINJECT_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(OPAINJECT_NAME)"; \
	shopt -s nullglob; \
	for dylib in "$(IOS_BUILD_DIR)"/libswift*.dylib; do install -m 0755 "$$dylib" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/"; done; \
	if [[ -z "$$prefix" && -f "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" ]]; then \
		install -d "$(THEOS_STAGING_DIR)/usr/lib/swift"; \
		install -m 0755 "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
		"$(LDID)" -S "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
	fi; \
	install -d "$(THEOS_STAGING_DIR)/usr/bin" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public"; \
	rsync -a --delete "$(ASSPPWEB_FRONTEND_DIST)/" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public/"; \
	install -d "$(THEOS_STAGING_DIR)/Library/LaunchDaemons"; \
	sed \
		-e "s|@INSTALL_PREFIX@|$$prefix|g" \
		-e "s|@DYLD_LIBRARY_PATH@|$$dyld_library_path|g" \
		-e "s|@LAUNCHD_PATH@|$$launchd_path|g" \
		packaging/wiki.qaq.unfaird.plist.in > "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"; \
	chmod 0644 "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"
endif
