SHELL := /bin/zsh

DEVICE_HOST ?=
PACKAGE_GLOB := backend-swift/debs/wiki.qaq.unfaird_*_iphoneos-arm64.deb

.PHONY: build package install install-version test clean-package list-releases

build:
	$(MAKE) -C backend-swift package FINALPACKAGE=1 ASSPPWEB_DIR=.. DEVICE_HOST="$(DEVICE_HOST)"
	@ls -t $(PACKAGE_GLOB) | head -n 1

package: build

test:
	cd backend-swift && swift test
	cd frontend && npm test

install: build
	@set -euo pipefail; \
	host="$(DEVICE_HOST)"; \
	device_ip="$(THEOS_DEVICE_IP)"; \
	device_user="$(THEOS_DEVICE_USER)"; \
	device_port="$(THEOS_DEVICE_PORT)"; \
	if [[ -z "$$device_user" ]]; then device_user="root"; fi; \
	if [[ -z "$$host" && -n "$$device_ip" ]]; then \
		if [[ "$$device_ip" == *@* ]]; then host="$$device_ip"; else host="$${device_user}@$$device_ip"; fi; \
	fi; \
	if [[ -z "$$host" ]]; then echo "DEVICE_HOST or THEOS_DEVICE_IP is required" >&2; exit 1; fi; \
	scp_args=(); \
	ssh_args=(); \
	if [[ -n "$$device_port" ]]; then scp_args=(-P "$$device_port"); ssh_args=(-p "$$device_port"); fi; \
	deb=$$(ls -t $(PACKAGE_GLOB) | head -n 1); \
	remote="/var/tmp/$${deb:t}"; \
	scp "$${scp_args[@]}" "$$deb" "$$host:$$remote"; \
	ssh "$${ssh_args[@]}" "$$host" "apt install -y '$$remote'"; \
	health_host="$${host#*@}"; \
	if [[ "$$health_host" == \[*\]* ]]; then health_host="$${health_host#\[}"; health_host="$${health_host%\]}"; fi; \
	if [[ "$$health_host" == *:* ]]; then health_host="[$$health_host]"; fi; \
	curl -fsS "http://$$health_host:8080/health"

# Install an already-built version without rebuilding it. Example:
# make install-version VERSION=0.1.2 DEVICE_HOST=root@192.168.1.128
install-version:
	@set -euo pipefail; \
	if [[ -z "$(VERSION)" ]]; then echo "VERSION is required" >&2; exit 1; fi; \
	deb="backend-swift/debs/wiki.qaq.unfaird_$(VERSION)_iphoneos-arm64.deb"; \
	if [[ ! -f "$$deb" ]]; then echo "release not found: $$deb" >&2; exit 1; fi; \
	host="$(DEVICE_HOST)"; \
	device_ip="$(THEOS_DEVICE_IP)"; \
	device_user="$(THEOS_DEVICE_USER)"; \
	device_port="$(THEOS_DEVICE_PORT)"; \
	if [[ -z "$$device_user" ]]; then device_user="root"; fi; \
	if [[ -z "$$host" && -n "$$device_ip" ]]; then \
		if [[ "$$device_ip" == *@* ]]; then host="$$device_ip"; else host="$${device_user}@$$device_ip"; fi; \
	fi; \
	if [[ -z "$$host" ]]; then echo "DEVICE_HOST or THEOS_DEVICE_IP is required" >&2; exit 1; fi; \
	scp_args=(); ssh_args=(); \
	if [[ -n "$$device_port" ]]; then scp_args=(-P "$$device_port"); ssh_args=(-p "$$device_port"); fi; \
	remote="/var/tmp/$${deb:t}"; \
	scp "$${scp_args[@]}" "$$deb" "$$host:$$remote"; \
	ssh "$${ssh_args[@]}" "$$host" "apt install -y --allow-downgrades '$$remote'"

list-releases:
	@setopt null_glob; releases=($(PACKAGE_GLOB)); \
	if (( $${#releases[@]} == 0 )); then echo "No local releases"; else printf '%s\n' "$${releases[@]}"; fi

clean-package:
	rm -rf backend-swift/.theos backend-swift/.build/ios-release
	@echo "Preserved versioned release packages in backend-swift/debs"
