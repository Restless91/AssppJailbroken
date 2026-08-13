#!/bin/sh
# unfaird Frida fallback via opainject + UnfairRuntimeDumper
# Pure shell, no Python. Runs on-device in unfaird context.
#
# UnfairRuntimeDumper config format (4 lines):
#   <output_path>     - where to write the decrypted binary
#   <status_path>     - where to write "ok" or "error:..."
#   0                 - flag (0 = normal)
#   <source_path>     - path to encrypted source binary on device
set -e

INPUT_IPA=""
OUTPUT_IPA=""
WORKDIR=""
VERBOSE=""

DUMPER_DIR="/var/jb/usr/local/lib/unfaird"
DUMPER_DYLIB="$DUMPER_DIR/UnfairRuntimeDumper.dylib"
OPAINJECT="$DUMPER_DIR/opainject"
TIMEOUT_CMD=""

# Detect timeout command
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD="timeout 45"
fi

while [ $# -gt 0 ]; do
    case "$1" in
        --input) INPUT_IPA="$2"; shift 2 ;;
        --output) OUTPUT_IPA="$2"; shift 2 ;;
        --workdir|--working-directory) WORKDIR="$2"; shift 2 ;;
        --verbose) VERBOSE=1; shift ;;
        *) shift ;;
    esac
done

[ -z "$INPUT_IPA" ] && { echo "ERROR: --input required" >&2; exit 1; }
[ -z "$OUTPUT_IPA" ] && { echo "ERROR: --output required" >&2; exit 1; }
[ -f "$INPUT_IPA" ] || { echo "ERROR: input IPA not found: $INPUT_IPA" >&2; exit 1; }

WORKDIR="${WORKDIR:-/tmp/unfaird-opainject-$$}"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

log()   { echo "[opainject-dump] $*" >&2; }
vv()    { [ -n "$VERBOSE" ] && echo "[opainject-dump:dbg] $*" >&2; }
die()   { log "FATAL: $*"; rm -rf "$WORKDIR"; exit 1; }

# --- Pre-flight ---
[ -f "$OPAINJECT" ]    || die "opainject not found: $OPAINJECT"
[ -f "$DUMPER_DYLIB" ] || die "UnfairRuntimeDumper.dylib not found: $DUMPER_DYLIB"

JOB_ID="$$-$(date +%s)"

# --- Step 1: Extract IPA metadata ---
log "Extracting IPA..."
EXTRACT_DIR="$WORKDIR/extract"
mkdir -p "$EXTRACT_DIR"
unzip -qo "$INPUT_IPA" -d "$EXTRACT_DIR" 2>/dev/null

APP_DIR=$(find "$EXTRACT_DIR/Payload" -maxdepth 1 -name "*.app" -type d 2>/dev/null | head -1)
[ -n "$APP_DIR" ] || die "No .app bundle found in IPA"
APP_NAME=$(basename "$APP_DIR" .app)
log "App: $APP_NAME"

BUNDLE_ID=""
[ -f "$APP_DIR/Info.plist" ] && BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_DIR/Info.plist" 2>/dev/null || echo "")
[ -n "$BUNDLE_ID" ] || die "Cannot determine bundle ID"
log "Bundle ID: $BUNDLE_ID"

# --- Step 2: Collect Mach-O files from the extracted IPA ---
log "Collecting binaries to dump..."
DUMP_INPUT="$WORKDIR/dump_input"
mkdir -p "$DUMP_INPUT"

# Find all Mach-O files in the app bundle (main exe, frameworks, plugins, dylibs)
MACHO_FILES="$WORKDIR/macho_files.txt"
:> "$MACHO_FILES"

is_macho() {
    # Check magic bytes at offset 0: FAT or thin Mach-O
    local f="$1"
    local magic
    magic=$(xxd -l 4 -p "$f" 2>/dev/null || echo "")
    case "$magic" in
        cafebabe|bebafeca|feedface|cefaedfe|feedfacf|cffaedfe) return 0 ;;
        *) return 1 ;;
    esac
}

find "$APP_DIR" -type f 2>/dev/null | while IFS= read -r f; do
    if is_macho "$f"; then
        rel="${f#$APP_DIR/}"
        echo "$rel" >> "$MACHO_FILES"
        vv "Found: $rel"
    fi
done

TOTAL=$(wc -l < "$MACHO_FILES" 2>/dev/null | tr -d ' ')
[ "$TOTAL" -gt 0 ] || die "No Mach-O binaries found in IPA"
log "Found $TOTAL binaries to process"

# --- Step 3: Install IPA ---
log "Installing IPA..."
if command -v appinst >/dev/null 2>&1; then
    appinst "$INPUT_IPA" 2>/dev/null || log "appinst returned non-zero (may be ok)"
fi
sleep 3

# --- Step 4: Launch app and get PID ---
log "Launching app..."
uiopen "$BUNDLE_ID" 2>/dev/null || open "$BUNDLE_ID" 2>/dev/null || true

APP_PID=""
for i in $(seq 1 30); do
    sleep 1
    # Search by process name matching app name
    APP_PID=$(ps -eo pid,comm 2>/dev/null | grep -i "$APP_NAME" | grep -v grep | head -1 | awk '{print $1}')
    [ -n "$APP_PID" ] && break
done
[ -n "$APP_PID" ] || die "App did not start within 30 seconds"
log "App PID: $APP_PID"
sleep 3  # Let frameworks fully load

# --- Step 5: Find app bundle path on device ---
APP_BUNDLE_PATH=""
for d in /var/containers/Bundle/Application/*/; do
    [ -d "${d}${APP_NAME}.app" ] || continue
    APP_BUNDLE_PATH="${d}${APP_NAME}.app"
    break
done
[ -n "$APP_BUNDLE_PATH" ] || die "Cannot find installed app bundle"
log "App bundle: $APP_BUNDLE_PATH"

# --- Step 6: Dump each binary ---
log "Dumping binaries..."
DUMP_OUT="$WORKDIR/dump_output"
mkdir -p "$DUMP_OUT"

SUCCESS_COUNT=0
FAIL_COUNT=0

dump_one() {
    local src="$1"        # full path on device
    local dst="$2"        # output path
    local pid="$3"

    local dylib="$WORKDIR/dumper_${JOB_ID}.dylib"
    cp "$DUMPER_DYLIB" "$dylib"

    local conf="${dylib}.${pid}.conf"
    local status="$WORKDIR/status_$(echo "$src" | md5sum 2>/dev/null | cut -c1-8 || echo "$RANDOM")"

    cat > "$conf" << EOF
$dst
$status
0
$src
EOF

    vv "Injecting: $(basename "$src")"
    $TIMEOUT_CMD "$OPAINJECT" "$pid" "$dylib" >/dev/null 2>&1 || true

    # Wait for status
    local waited=0
    while [ $waited -lt 15 ]; do
        if [ -f "$status" ]; then
            local s
            s=$(head -1 "$status" 2>/dev/null)
            case "$s" in
                ok)
                    rm -f "$dylib" "$conf" "$status"
                    return 0
                    ;;
                error:*)
                    log "Dump error for $(basename "$src"): $s"
                    rm -f "$dylib" "$conf" "$status"
                    return 1
                    ;;
            esac
        fi
        sleep 1
        waited=$((waited + 1))
    done

    # Fallback: check if output exists and is non-empty
    if [ -f "$dst" ] && [ -s "$dst" ]; then
        log "Status timeout, but output exists: $(wc -c < "$dst") bytes"
        rm -f "$dylib" "$conf" "$status"
        return 0
    fi

    log "Timeout: $(basename "$src")"
    rm -f "$dylib" "$conf" "$status"
    return 1
}

while IFS= read -r relpath; do
    [ -z "$relpath" ] && continue

    src="$APP_BUNDLE_PATH/$relpath"
    [ -f "$src" ] || { log "SKIP (not found): $relpath"; continue; }

    safe="$(echo "$relpath" | tr '/' '_')"
    dst="$DUMP_OUT/$safe"

    log "Dumping: $relpath"
    if dump_one "$src" "$dst" "$APP_PID"; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        log "  OK: $relpath"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        log "  FAILED: $relpath"
    fi
done < "$MACHO_FILES"

log "Results: $SUCCESS_COUNT succeeded, $FAIL_COUNT failed"
[ "$SUCCESS_COUNT" -gt 0 ] || die "No binaries were dumped"

# --- Step 7: Merge ---
log "Merging decrypted binaries into IPA..."
MERGED_DIR="$WORKDIR/merged"
mkdir -p "$MERGED_DIR/Payload"
cp -R "$APP_DIR" "$MERGED_DIR/Payload/"
MERGED_APP="$MERGED_DIR/Payload/$APP_NAME.app"

for f in "$DUMP_OUT"/*; do
    [ -f "$f" ] || continue
    safe="$(basename "$f")"
    rel="$(echo "$safe" | tr '_' '/')"
    target="$MERGED_APP/$rel"
    if [ -f "$target" ]; then
        cp -f "$f" "$target"
        chmod +x "$target" 2>/dev/null || true
    else
        # Fuzzy search
        log "Exact path not found for $safe, searching..."
        find "$MERGED_APP" -type f 2>/dev/null | while IFS= read -r cand; do
            cand_rel="${cand#$MERGED_APP/}"
            cand_safe="$(echo "$cand_rel" | tr '/' '_')"
            if [ "$cand_safe" = "$safe" ]; then
                cp -f "$f" "$cand"
                chmod +x "$cand" 2>/dev/null || true
                break
            fi
        done
    fi
done

# --- Step 8: Repack ---
log "Repacking IPA..."
cd "$MERGED_DIR"
zip -qr "$OUTPUT_IPA" Payload/
cd /

if [ -f "$OUTPUT_IPA" ]; then
    SIZE=$(wc -c < "$OUTPUT_IPA" | tr -d ' ')
    log "SUCCESS: $OUTPUT_IPA ($SIZE bytes, $SUCCESS_COUNT decrypted)"
else
    die "Output IPA not created"
fi

rm -rf "$WORKDIR"
log "Done."
