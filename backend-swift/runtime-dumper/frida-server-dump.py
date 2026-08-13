#!/usr/bin/env python3
"""frida-server-dump.py -- UnfairD frida fallback helper

Connects to the local frida-server, attaches to the target process (or spawns it),
runs the dump script, and writes a status file for the unfaird daemon to poll.

Usage: python3 frida-server-dump.py <config.json>
"""

import frida
import json
import sys
import os
import time
import signal

TIMEOUT_SECONDS = 60
FRIDA_SERVER = "127.0.0.1:27042"


def main():
    if len(sys.argv) < 2:
        die("usage: frida-server-dump.py <config.json>", None)

    config_path = sys.argv[1]
    if not os.path.exists(config_path):
        die("config file not found: " + config_path, None)

    with open(config_path, "r") as f:
        config = json.load(f)

    image_path = config.get("image", "")
    output_path = config.get("output", "")
    status_path = config.get("status", "")
    bundle_id = config.get("bundle_id", "")
    executable_name = config.get("executable", "")

    if not image_path:
        die("config missing 'image' field", status_path)
    if not output_path:
        die("config missing 'output' field", status_path)
    if not status_path:
        die("config missing 'status' field", None)

    # Resolve status fallback
    if not os.path.isabs(status_path):
        status_path = os.path.join(os.path.dirname(config_path), status_path)

    try:
        device = frida.get_device_manager().add_remote_device(FRIDA_SERVER)
    except Exception as e:
        die("cannot connect to frida-server: " + str(e), status_path)

    # Find or spawn the target process
    pid = find_or_spawn(device, bundle_id, executable_name, image_path)

    if pid is None:
        die("cannot find process for bundle_id=" + bundle_id, status_path)

    # Determine which JS script to load and embed config inline
    dump_js_path = find_agent_js()
    if not dump_js_path:
        die("dump agent not found: frida-server-dump-agent.js", status_path)

    with open(dump_js_path, "r") as f:
        js_code = f.read()

    # Embed config as a global variable for the agent
    embedded_config = json.dumps({
        "image": image_path,
        "output": output_path,
        "status": status_path,
    })
    js_preamble = "var __UNFAIR_FRIDA_CONFIG__ = {};\n".format(embedded_config)
    js_full = js_preamble + js_code

    try:
        session = device.attach(int(pid))
    except Exception as e:
        die("attach failed for pid={}: {}".format(pid, e), status_path)

    # Set up a timeout alarm
    completed = [False]

    def on_timeout(signum, frame):
        if not completed[0]:
            write_status(status_path, "error: timeout after {}s".format(TIMEOUT_SECONDS))
            os._exit(1)

    signal.signal(signal.SIGALRM, on_timeout)
    signal.alarm(TIMEOUT_SECONDS)

    try:
        script = session.create_script(js_full)

        def on_message(msg, data):
            if msg["type"] == "send":
                payload = msg.get("payload", "")
                if isinstance(payload, str) and payload.startswith("ok"):
                    write_status(status_path, "ok")
                    completed[0] = True
                elif isinstance(payload, str) and payload.startswith("error"):
                    write_status(status_path, payload)
                    completed[0] = True

        script.on("message", on_message)
        script.load()

        # Poll until completion or timeout
        deadline = time.time() + TIMEOUT_SECONDS
        while not completed[0] and time.time() < deadline:
            time.sleep(0.5)

        if not completed[0]:
            write_status(status_path, "error: completion timeout")

    except Exception as e:
        write_status(status_path, "error: script failed: " + str(e))
    finally:
        signal.alarm(0)
        try:
            session.detach()
        except Exception:
            pass


def find_agent_js():
    """Search for frida-server-dump-agent.js in all known locations."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "frida-server-dump-agent.js"),
        "/var/jb/usr/local/lib/unfaird/runtime-dumper/frida-server-dump-agent.js",
        "/var/jb/usr/local/lib/unfaird/frida-server-dump-agent.js",
        "/usr/local/lib/unfaird/runtime-dumper/frida-server-dump-agent.js",
        "/usr/local/lib/unfaird/frida-server-dump-agent.js",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def find_or_spawn(device, bundle_id, executable_name, image_path):
    """Find the target process, spawning if needed."""
    # Try to find an existing process by bundle ID
    if bundle_id:
        try:
            apps = device.enumerate_applications()
            for app in apps:
                if app.identifier == bundle_id:
                    # Check if already running
                    for proc in device.enumerate_processes():
                        if proc.pid > 0 and bundle_id in str(proc.name):
                            return proc.pid
                        # Also check by executable name
                        if executable_name and proc.name == executable_name:
                            return proc.pid
                    # Not running, try spawning
                    try:
                        pid = device.spawn([bundle_id])
                        device.resume(pid)
                        time.sleep(3)
                        return pid
                    except Exception:
                        pass
                    break
        except Exception:
            pass

    # Fallback: enumerate processes and match by executable name
    if executable_name:
        try:
            for proc in device.enumerate_processes():
                if proc.name == executable_name:
                    return proc.pid
        except Exception:
            pass

    # Last resort: try to find by image path substring matching
    if image_path:
        image_name = os.path.basename(image_path)
        try:
            for proc in device.enumerate_processes():
                if proc.name == image_name:
                    return proc.pid
        except Exception:
            pass

    return None


def write_status(path, msg):
    try:
        d = os.path.dirname(path)
        if d and not os.path.exists(d):
            os.makedirs(d, exist_ok=True)
        with open(path, "w") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def die(msg, status_path):
    sys.stderr.write(msg + "\n")
    if status_path:
        write_status(status_path, "error: " + msg)
    sys.exit(1)


if __name__ == "__main__":
    main()
