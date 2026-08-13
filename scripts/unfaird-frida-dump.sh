#!/bin/sh
# unfaird Frida fallback decryption script
# Runs on-device: uses local frida-server to dump decrypted app binaries
set -e

INPUT_IPA=""
OUTPUT_IPA=""
WORKDIR=""
VERBOSE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --input) INPUT_IPA="$2"; shift 2 ;;
        --output) OUTPUT_IPA="$2"; shift 2 ;;
        --working-directory|--workdir) WORKDIR="$2"; shift 2 ;;
        --verbose) VERBOSE=1; shift ;;
        *) echo "Unknown arg: $1"; shift ;;
    esac
done

if [ -z "$INPUT_IPA" ] || [ -z "$OUTPUT_IPA" ]; then
    echo "Usage: $0 --input <ipa> --output <ipa> [--workdir <dir>]" >&2
    exit 1
fi

WORKDIR="${WORKDIR:-/tmp/unfaird-frida-$$}"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

log() { echo "[frida-dump] $*" >&2; }
vv() { [ -n "$VERBOSE" ] && echo "[frida-dump:verbose] $*" >&2; }

log "Starting Frida fallback decryption"
log "Input:  $INPUT_IPA"
log "Output: $OUTPUT_IPA"
log "Work:   $WORKDIR"

# --- Step 1: Extract bundle ID ---
log "Extracting bundle identifier..."
BUNDLE_ID=""
# Try iTunesMetadata.plist first
if unzip -p "$INPUT_IPA" "iTunesMetadata.plist" > "$WORKDIR/itunes.plist" 2>/dev/null; then
    BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print softwareVersionBundleId" "$WORKDIR/itunes.plist" 2>/dev/null || echo "")
fi
# Fallback: find Info.plist in Payload/*.app/
if [ -z "$BUNDLE_ID" ]; then
    TMP_PAYLOAD="$WORKDIR/payload_extract"
    mkdir -p "$TMP_PAYLOAD"
    unzip -qo "$INPUT_IPA" -d "$TMP_PAYLOAD" 2>/dev/null
    APP_DIR=$(find "$TMP_PAYLOAD/Payload" -name "*.app" -type d 2>/dev/null | head -1)
    if [ -n "$APP_DIR" ] && [ -f "$APP_DIR/Info.plist" ]; then
        BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_DIR/Info.plist" 2>/dev/null || echo "")
    fi
    rm -rf "$TMP_PAYLOAD"
fi

if [ -z "$BUNDLE_ID" ]; then
    log "ERROR: Could not determine bundle identifier"
    exit 1
fi
log "Bundle ID: $BUNDLE_ID"

# --- Step 2: Extract app name from IPA ---
TMP_PAYLOAD="$WORKDIR/payload_extract"
mkdir -p "$TMP_PAYLOAD"
unzip -qo "$INPUT_IPA" -d "$TMP_PAYLOAD" 2>/dev/null
APP_DIR=$(find "$TMP_PAYLOAD/Payload" -name "*.app" -type d 2>/dev/null | head -1)
APP_NAME=$(basename "$APP_DIR" .app)
log "App name: $APP_NAME"

# --- Step 3: Install the IPA ---
log "Installing IPA..."
# Try appinst first (RootHide), fall back to normal install
if command -v appinst > /dev/null 2>&1; then
    appinst "$INPUT_IPA" 2>&1 | while IFS= read -r line; do vv "appinst: $line"; done
else
    # Use the IPA directly via the Installer framework
    log "appinst not found, using raw install method"
fi

# Wait for install
sleep 2

# --- Step 4: Run Frida dump ---
log "Launching Frida dump via Python..."
FRIDA_DUMP_PY="/usr/sbin/unfaird-frida-dump.py"
DUMP_OUT="$WORKDIR/dump_output"

# Ensure frida Python package is available
if ! python3 -c "import frida" 2>/dev/null; then
    log "Installing frida Python package..."
    python3 -m ensurepip --default-pip 2>/dev/null || true
    pip3 install frida frida-tools --break-system-packages 2>&1 | while IFS= read -r line; do vv "pip: $line"; done
fi

mkdir -p "$DUMP_OUT"
python3 "$FRIDA_DUMP_PY" \
    --bundle-id "$BUNDLE_ID" \
    --output-dir "$DUMP_OUT" \
    --frida-host "127.0.0.1" \
    2>&1 | while IFS= read -r line; do
        log "frida: $line"
    done

# --- Step 5: Check results ---
DECRYPTED_APP=$(find "$DUMP_OUT" -name "*.app" -type d 2>/dev/null | head -1)
if [ -z "$DECRYPTED_APP" ]; then
    log "ERROR: No decrypted .app bundle found"
    exit 1
fi
log "Decrypted app found: $DECRYPTED_APP"

# --- Step 6: Merge decrypted binaries back into original IPA ---
log "Merging decrypted binaries into IPA..."
MERGED_DIR="$WORKDIR/merged"
mkdir -p "$MERGED_DIR/Payload"

# Copy original Payload
cp -R "$APP_DIR" "$MERGED_DIR/Payload/"

# Replace binaries with decrypted versions
DECRYPTED_APP_NAME=$(basename "$DECRYPTED_APP")
TARGET_APP="$MERGED_DIR/Payload/$DECRYPTED_APP_NAME"

for dec_file in "$DECRYPTED_APP"/*; do
    fname=$(basename "$dec_file")
    target="$TARGET_APP/$fname"
    if [ -f "$target" ]; then
        log "Replacing: $fname"
        cp -f "$dec_file" "$target"
    fi
done

# Also replace frameworks/plugins if they were decrypted
for dec_fw in "$DECRYPTED_APP/Frameworks"/*.framework 2>/dev/null; do
    [ -d "$dec_fw" ] || continue
    fw_name=$(basename "$dec_fw")
    dec_dylib=$(find "$dec_fw" -type f ! -name "*.plist" ! -name "*.nib" ! -name "*.png" | head -1)
    [ -n "$dec_dylib" ] || continue
    dylib_name=$(basename "$dec_dylib")
    target_fw="$TARGET_APP/Frameworks/$fw_name"
    if [ -d "$target_fw" ]; then
        target_dylib="$target_fw/$dylib_name"
        if [ -f "$target_dylib" ]; then
            log "Replacing framework: $fw_name/$dylib_name"
            cp -f "$dec_dylib" "$target_dylib"
        fi
    fi
done

# --- Step 7: Repack IPA ---
log "Repacking IPA..."
cd "$MERGED_DIR"
zip -qr "$OUTPUT_IPA" Payload/
cd /

# --- Step 8: Verify ---
if [ -f "$OUTPUT_IPA" ]; then
    SIZE=$(stat -f%z "$OUTPUT_IPA" 2>/dev/null || stat -c%s "$OUTPUT_IPA" 2>/dev/null || echo "0")
    log "SUCCESS: Decrypted IPA created at $OUTPUT_IPA ($SIZE bytes)"
else
    log "ERROR: Failed to create output IPA"
    exit 1
fi

# Cleanup
rm -rf "$WORKDIR"
log "Frida fallback decryption complete"

