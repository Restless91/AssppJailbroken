#!/bin/sh
# unfaird launcher — sets up environment and starts the daemon
export PATH=/var/jb/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin

export DATA_DIR=/var/mobile/AssppWebData
export PUBLIC_DIR=/var/mobile/AssppWebData/public
export DOWNLOAD_THREADS=8
export UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=true

# --- Ensure public directory is populated ---
PUBLIC_SRC="/var/jb/usr/share/assppweb/public"
PUBLIC_DST="$PUBLIC_DIR"

if [ -d "$PUBLIC_SRC" ] && [ -f "$PUBLIC_SRC/index.html" ]; then
    mkdir -p "$PUBLIC_DST"
    # Only copy if destination is missing or source is newer
    if [ ! -f "$PUBLIC_DST/index.html" ] || [ "$PUBLIC_SRC/index.html" -nt "$PUBLIC_DST/index.html" ]; then
        echo "[launcher] Syncing public files to $PUBLIC_DST"
        rsync -a --delete "$PUBLIC_SRC/" "$PUBLIC_DST/" 2>/dev/null || cp -R "$PUBLIC_SRC/"* "$PUBLIC_DST/" 2>/dev/null
    fi
fi

# --- Ensure Frida fallback scripts are in place ---
if [ ! -f /usr/sbin/unfaird-frida-dump.sh ]; then
    echo "[launcher] WARNING: Frida fallback script not found at /usr/sbin/unfaird-frida-dump.sh"
fi

# --- Ensure DATA_DIR exists ---
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/packages"

exec /usr/sbin/unfaird serve --hostname 0.0.0.0 --port 8080
