#!/usr/bin/env python3
"""
On-device Frida dump script for unfaird fallback.
Connects to local frida-server, dumps decrypted binaries from a running app.
No SSH/SCP needed — everything is local.
"""

import sys
import os
import shutil
import argparse
import threading
import subprocess
import tempfile
import json

try:
    import frida
except ImportError:
    print("ERROR: frida Python package not installed. Run: pip3 install frida", file=sys.stderr)
    sys.exit(1)

finished = threading.Event()
file_dict = {}
TEMP_DIR = tempfile.gettempdir()

# ---------------------------------------------------------------------------
# dump.js — injected into the target process
# ---------------------------------------------------------------------------
DUMP_JS = r"""
var O_RDONLY = 0;
var O_WRONLY = 1;
var O_RDWR = 2;
var O_CREAT = 512;
var SEEK_SET = 0;
var SEEK_CUR = 1;
var SEEK_END = 2;
var DT_DIR = 4;

var getenv_fn = new NativeFunction(Module.getGlobalExportByName("getenv"), "pointer", ["pointer"]);
var wrapper_open = new NativeFunction(Module.getGlobalExportByName("open"), "int", ["pointer", "int", "int"]);
var read = new NativeFunction(Module.getGlobalExportByName("read"), "int", ["int", "pointer", "int"]);
var write = new NativeFunction(Module.getGlobalExportByName("write"), "int", ["int", "pointer", "int"]);
var lseek = new NativeFunction(Module.getGlobalExportByName("lseek"), "int64", ["int", "int64", "int"]);
var close_fn = new NativeFunction(Module.getGlobalExportByName("close"), "int", ["int"]);
var remove_fn = new NativeFunction(Module.getGlobalExportByName("remove"), "int", ["pointer"]);
var access_fn = new NativeFunction(Module.getGlobalExportByName("access"), "int", ["pointer", "int"]);
var dlopen_fn = new NativeFunction(Module.getGlobalExportByName("dlopen"), "pointer", ["pointer", "int"]);
var opendir_fn = new NativeFunction(Module.getGlobalExportByName("opendir"), "pointer", ["pointer"]);
var readdir_fn = new NativeFunction(Module.getGlobalExportByName("readdir"), "pointer", ["pointer"]);
var closedir_fn = new NativeFunction(Module.getGlobalExportByName("closedir"), "int", ["pointer"]);

function getenvStr(name) {
    var p = getenv_fn(Memory.allocUtf8String(name));
    if (p.isNull()) return null;
    return p.readUtf8String();
}

function getTmpDir() {
    var tmp = getenvStr("TMPDIR");
    if (tmp) return tmp;
    var home = getenvStr("HOME");
    if (home) return home + "/tmp";
    return "/tmp";
}

var TMPDIR = getTmpDir();

function getAppPath() {
    var mainPath = Process.mainModule.path;
    var idx = mainPath.lastIndexOf(".app");
    if (idx != -1) return mainPath.substring(0, idx + 4);
    return mainPath.substring(0, mainPath.lastIndexOf("/"));
}

var modules = null;
function getAllAppModules() {
    modules = [];
    var tmpmods = Process.enumerateModules();
    for (var i = 0; i < tmpmods.length; i++) {
        if (tmpmods[i].path.indexOf(".app") != -1) {
            modules.push(tmpmods[i]);
        }
    }
    return modules;
}

var FAT_MAGIC = 0xcafebabe;
var FAT_CIGAM = 0xbebafeca;
var MH_MAGIC = 0xfeedface;
var MH_CIGAM = 0xcefaedfe;
var MH_MAGIC_64 = 0xfeedfacf;
var MH_CIGAM_64 = 0xcffaedfe;
var LC_ENCRYPTION_INFO = 0x21;
var LC_ENCRYPTION_INFO_64 = 0x2C;

function pad(str, n) {
    return Array(n - str.length + 1).join("0") + str;
}

function swap32(value) {
    value = pad(value.toString(16), 8);
    var result = "";
    for (var i = 0; i < value.length; i = i + 2) {
        result += value.charAt(value.length - i - 2);
        result += value.charAt(value.length - i - 1);
    }
    return parseInt(result, 16);
}

function dumpModule(name) {
    if (modules == null) modules = getAllAppModules();
    var targetIndex = -1;
    for (var i = 0; i < modules.length; i++) {
        if (modules[i].path.indexOf(name) != -1) { targetIndex = i; break; }
    }
    if (targetIndex == -1) { console.log("Cannot find module: " + name); return null; }
    var mod = modules[targetIndex];
    var modbase = mod.base;
    var newmodname = mod.name;
    var newmodpath = TMPDIR + "/" + newmodname + ".fid";
    var oldmodpath = mod.path;
    if (!access_fn(Memory.allocUtf8String(newmodpath), 0)) remove_fn(Memory.allocUtf8String(newmodpath));
    var fmodule = wrapper_open(Memory.allocUtf8String(newmodpath), O_CREAT | O_RDWR, 0);
    var foldmodule = wrapper_open(Memory.allocUtf8String(oldmodpath), O_RDONLY, 0);
    if (fmodule == -1 || foldmodule == -1) { console.log("Cannot open file"); return null; }
    var size_of_mach_header = 0;
    var magic = modbase.readU32();
    var cur_cpu_type = modbase.add(4).readU32();
    if (magic == MH_MAGIC || magic == MH_CIGAM) size_of_mach_header = 28;
    else if (magic == MH_MAGIC_64 || magic == MH_CIGAM_64) size_of_mach_header = 32;
    var BUFSIZE = 4096;
    var buffer = Memory.alloc(BUFSIZE);
    read(foldmodule, buffer, BUFSIZE);
    var fileoffset = 0;
    var filesize = 0;
    magic = buffer.readU32();
    if (magic == FAT_CIGAM || magic == FAT_MAGIC) {
        var off = 4;
        var archs = swap32(buffer.add(off).readU32());
        for (var i = 0; i < archs; i++) {
            var cputype = swap32(buffer.add(off + 4).readU32());
            if (cur_cpu_type == cputype) {
                fileoffset = swap32(buffer.add(off + 8).readU32());
                filesize = swap32(buffer.add(off + 12).readU32());
                break;
            }
            off += 20;
        }
        if (filesize == 0) { close_fn(fmodule); close_fn(foldmodule); return null; }
        lseek(fmodule, 0, SEEK_SET);
        lseek(foldmodule, fileoffset, SEEK_SET);
        for (var i = 0; i < parseInt(filesize / BUFSIZE); i++) {
            read(foldmodule, buffer, BUFSIZE);
            write(fmodule, buffer, BUFSIZE);
        }
        if (filesize % BUFSIZE) { read(foldmodule, buffer, filesize % BUFSIZE); write(fmodule, buffer, filesize % BUFSIZE); }
    } else {
        var readLen = 0;
        lseek(foldmodule, 0, SEEK_SET);
        lseek(fmodule, 0, SEEK_SET);
        while ((readLen = read(foldmodule, buffer, BUFSIZE))) write(fmodule, buffer, readLen);
    }
    var ncmds = modbase.add(16).readU32();
    var off = size_of_mach_header;
    var offset_cryptid = -1;
    var crypt_off = 0;
    var crypt_size = 0;
    for (var i = 0; i < ncmds; i++) {
        var cmd = modbase.add(off).readU32();
        var cmdsize = modbase.add(off + 4).readU32();
        if (cmd == LC_ENCRYPTION_INFO || cmd == LC_ENCRYPTION_INFO_64) {
            offset_cryptid = off + 16;
            crypt_off = modbase.add(off + 8).readU32();
            crypt_size = modbase.add(off + 12).readU32();
        }
        off += cmdsize;
    }
    if (offset_cryptid != -1) {
        var tpbuf = Memory.alloc(8);
        tpbuf.writeU64(0);
        lseek(fmodule, offset_cryptid, SEEK_SET);
        write(fmodule, tpbuf, 4);
        if (crypt_size > 0) {
            lseek(fmodule, crypt_off, SEEK_SET);
            write(fmodule, modbase.add(crypt_off), crypt_size);
        }
    }
    close_fn(fmodule);
    close_fn(foldmodule);
    return newmodpath;
}

function listDirectory(path) {
    var items = [];
    var dir = opendir_fn(Memory.allocUtf8String(path));
    if (dir.isNull()) return items;
    var entry;
    while ((entry = readdir_fn(dir))) {
        if (entry.isNull()) break;
        var name = entry.add(21).readUtf8String();
        if (name === "." || name === "..") continue;
        var d_type = entry.add(20).readU8();
        items.push({name: name, isDir: d_type == DT_DIR});
    }
    closedir_fn(dir);
    return items;
}

function loadAllDynamicLibrary(app_path) {
    var items = listDirectory(app_path);
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var file_path = app_path + "/" + item.name;
        if (item.name.indexOf(".framework") != -1) {
            if (item.isDir) {
                var fwItems = listDirectory(file_path);
                for (var j = 0; j < fwItems.length; j++) {
                    if (fwItems[j].name.indexOf(".framework") == -1 && !fwItems[j].isDir) {
                        var fwPath = file_path + "/" + fwItems[j].name;
                        var loaded = false;
                        for (var k = 0; k < modules.length; k++) {
                            if (modules[k].path.indexOf(fwItems[j].name) != -1) { loaded = true; break; }
                        }
                        if (!loaded) {
                            if (dlopen_fn(Memory.allocUtf8String(fwPath), 9))
                                console.log("[dump.js] dlopen " + fwItems[j].name + " success.");
                            else
                                console.log("[dump.js] dlopen " + fwItems[j].name + " failed.");
                        }
                    }
                }
            }
        } else if (item.isDir) {
            loadAllDynamicLibrary(file_path);
        } else if (item.name.indexOf(".dylib") != -1) {
            var loaded = false;
            for (var j = 0; j < modules.length; j++) {
                if (modules[j].path.indexOf(item.name) != -1) { loaded = true; break; }
            }
            if (!loaded) {
                if (dlopen_fn(Memory.allocUtf8String(file_path), 9))
                    console.log("[dump.js] dlopen " + item.name + " success.");
                else
                    console.log("[dump.js] dlopen " + item.name + " failed.");
            }
        }
    }
}

function handleMessage(message) {
    modules = getAllAppModules();
    var app_path = getAppPath();
    loadAllDynamicLibrary(app_path);
    modules = getAllAppModules();
    for (var i = 0; i < modules.length; i++) {
        console.log("start dump " + modules[i].path);
        var result = dumpModule(modules[i].path);
        send({dump: result, path: modules[i].path});
    }
    send({app: app_path});
    send({done: "ok"});
}

recv(handleMessage);
"""

# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def get_local_device():
    """Connect to local frida-server"""
    manager = frida.get_device_manager()
    # Try local devices first
    for dev in manager.enumerate_devices():
        if dev.type == 'local' or dev.type == 'usb' or dev.type == 'tether':
            return dev
    # Fallback: add remote device at localhost
    return manager.add_remote_device("127.0.0.1:27042")

def get_applications(device):
    """List installed applications"""
    try:
        return device.enumerate_applications()
    except Exception as e:
        print(f"Error enumerating apps: {e}", file=sys.stderr)
        return []

def on_message(message, data):
    if 'payload' in message:
        payload = message['payload']

        if 'dump' in payload and payload['dump']:
            origin_path = payload['path']
            dump_path = payload['dump']
            dest_name = os.path.basename(dump_path)
            dest_path = os.path.join(OUTPUT_DIR, dest_name)
            shutil.copy2(dump_path, dest_path)
            os.chmod(dest_path, 0o755)
            # Track where this file goes in the .app structure
            index = origin_path.find('.app/')
            if index != -1:
                file_dict[dest_name] = origin_path[index + 5:]
            else:
                file_dict[dest_name] = dest_name
            print(f"  dumped: {dest_name}")

        if 'app' in payload:
            app_path = payload['app']
            app_name = os.path.basename(app_path)
            dest_app = os.path.join(OUTPUT_DIR, app_name)
            if os.path.exists(app_path) and os.path.isdir(app_path):
                shutil.copytree(app_path, dest_app, symlinks=True)
                print(f"  copied app bundle: {app_name}")
                file_dict['app'] = app_name

        if 'done' in payload:
            finished.set()

def assemble_app_bundle():
    """Place decrypted binaries into the correct positions within the .app bundle"""
    if 'app' not in file_dict:
        print("ERROR: app bundle name not found", file=sys.stderr)
        return False

    app_name = file_dict['app']
    app_path = os.path.join(OUTPUT_DIR, app_name)

    for fname, relative_path in file_dict.items():
        if fname == 'app':
            continue
        src = os.path.join(OUTPUT_DIR, fname)
        dst = os.path.join(app_path, relative_path)
        if os.path.exists(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            os.chmod(dst, 0o755)
            print(f"  assembled: {relative_path}")

    return True

def open_target_app(device, bundle_id):
    """Find or spawn the target app"""
    print(f"Looking for app: {bundle_id}")

    pid = None
    display_name = bundle_id

    for app in get_applications(device):
        if app.identifier == bundle_id:
            display_name = app.name
            if app.pid != 0:
                pid = app.pid
                print(f"Found running app: {display_name} (PID: {pid})")
            break

    try:
        if pid:
            session = device.attach(pid)
        else:
            print(f"Spawning app: {bundle_id}")
            pid = device.spawn([bundle_id])
            session = device.attach(pid)
            device.resume(pid)
            print(f"Spawned with PID: {pid}")

        # Give the app time to start and load frameworks
        import time
        time.sleep(2)

        return session, display_name
    except Exception as e:
        print(f"ERROR attaching to app: {e}", file=sys.stderr)
        return None, None

def main():
    parser = argparse.ArgumentParser(description='On-device Frida iOS dump for unfaird')
    parser.add_argument('--bundle-id', required=True, help='Bundle identifier of target app')
    parser.add_argument('--output-dir', required=True, help='Directory for decrypted output')
    parser.add_argument('--frida-host', default='127.0.0.1', help='Frida server host (default: 127.0.0.1)')
    args = parser.parse_args()

    global OUTPUT_DIR
    OUTPUT_DIR = args.output_dir
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Connect to frida
    print(f"Connecting to frida-server at {args.frida_host}...")
    if args.frida_host == '127.0.0.1':
        device = get_local_device()
    else:
        manager = frida.get_device_manager()
        device = manager.add_remote_device(f"{args.frida_host}:27042")
    print(f"Connected: {device.name} ({device.type})")

    # Open target app
    session, display_name = open_target_app(device, args.bundle_id)
    if session is None:
        print("ERROR: Could not open target app", file=sys.stderr)
        sys.exit(1)

    try:
        # Create and load dump script
        print("Injecting dump script...")
        script = session.create_script(DUMP_JS)
        script.on('message', on_message)
        script.load()

        # Trigger dump
        print("Starting dump...")
        script.post({'type': 'dump'})

        # Wait for completion (timeout: 15 minutes)
        if not finished.wait(timeout=900):
            print("ERROR: Dump timed out after 15 minutes", file=sys.stderr)
            sys.exit(1)

        # Assemble the app bundle
        print("Assembling decrypted app bundle...")
        if assemble_app_bundle():
            print(f"Dump complete! Output: {OUTPUT_DIR}")
        else:
            print("ERROR: Assembly failed", file=sys.stderr)
            sys.exit(1)
    finally:
        if session:
            session.detach()
            print("Session detached")

if __name__ == '__main__':
    main()
