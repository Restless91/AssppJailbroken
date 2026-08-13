// frida-dump.js - Frida 17 gadget auto-dump for unfaird fallback
// Reads $HOME/Documents/unfair-frida/config.json, dumps the requested
// Mach-O image from process memory, and writes a status file.
(function () {
    'use strict';

    var O_RDONLY = 0;
    var O_WRONLY = 1;
    var O_RDWR = 2;
    var O_CREAT = 512;
    var SEEK_SET = 0;
    var SEEK_CUR = 1;
    var SEEK_END = 2;

    var FAT_MAGIC = 0xcafebabe;
    var FAT_CIGAM = 0xbebafeca;
    var MH_MAGIC = 0xfeedface;
    var MH_CIGAM = 0xcefaedfe;
    var MH_MAGIC_64 = 0xfeedfacf;
    var MH_CIGAM_64 = 0xcffaedfe;
    var LC_ENCRYPTION_INFO = 0x21;
    var LC_ENCRYPTION_INFO_64 = 0x2C;

    function cfunc(name, ret, args) {
        return new NativeFunction(Module.getGlobalExportByName(name), ret, args);
    }

    var getenv_fn = cfunc("getenv", "pointer", ["pointer"]);
    var fopen = cfunc("fopen", "pointer", ["pointer", "pointer"]);
    var fread = cfunc("fread", "size_t", ["pointer", "size_t", "size_t", "pointer"]);
    var fwrite = cfunc("fwrite", "size_t", ["pointer", "size_t", "size_t", "pointer"]);
    var fclose = cfunc("fclose", "int", ["pointer"]);
    var wrapper_open = cfunc("open", "int", ["pointer", "int", "int"]);
    var read = cfunc("read", "int", ["int", "pointer", "int"]);
    var write = cfunc("write", "int", ["int", "pointer", "int"]);
    var lseek = cfunc("lseek", "int64", ["int", "int64", "int"]);
    var close = cfunc("close", "int", ["int"]);
    var remove_fn = cfunc("remove", "int", ["pointer"]);
    var access_fn = cfunc("access", "int", ["pointer", "int"]);

    function getenvStr(name) {
        var p = getenv_fn(Memory.allocUtf8String(name));
        return (p.isNull()) ? null : p.readUtf8String();
    }

    function readTextFile(path) {
        var fp = fopen(Memory.allocUtf8String(path), Memory.allocUtf8String("r"));
        if (fp.isNull()) return null;
        var buf = Memory.alloc(262144);
        var n = fread(buf, 1, 262143, fp);
        fclose(fp);
        if (n <= 0) return "";
        return buf.readUtf8String(n) || "";
    }

    function writeTextFile(path, text) {
        var fp = fopen(Memory.allocUtf8String(path), Memory.allocUtf8String("w"));
        if (fp.isNull()) return false;
        var bytes = Memory.allocUtf8String(text);
        fwrite(bytes, 1, text.length, fp);
        fclose(fp);
        return true;
    }

    function openFile(pathname, flags, mode) {
        return wrapper_open(Memory.allocUtf8String(pathname), flags, mode);
    }

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

    function findModule(imagePath) {
        var mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) {
            var candidate = mods[i].path;
            if (candidate === imagePath ||
                candidate.endsWith("/" + imagePath) ||
                candidate.endsWith(imagePath)) {
                return mods[i];
            }
        }
        return null;
    }

    function dumpModule(imagePath, outputPath) {
        var mod = findModule(imagePath);
        if (mod === null) {
            return "module not loaded: " + imagePath;
        }

        var modbase = mod.base;

        if (!access_fn(Memory.allocUtf8String(outputPath), 0)) {
            remove_fn(Memory.allocUtf8String(outputPath));
        }

        var fmodule = openFile(outputPath, O_CREAT | O_RDWR, 0);
        var foldmodule = openFile(mod.path, O_RDONLY, 0);
        if (fmodule === -1 || foldmodule === -1) {
            return "cannot open files";
        }

        var size_of_mach_header = 0;
        var magic = modbase.readU32();
        var cur_cpu_type = modbase.add(4).readU32();
        var cur_cpu_subtype = modbase.add(8).readU32();
        if (magic === MH_MAGIC || magic === MH_CIGAM) {
            size_of_mach_header = 28;
        } else if (magic === MH_MAGIC_64 || magic === MH_CIGAM_64) {
            size_of_mach_header = 32;
        }

        var BUFSIZE = 4096;
        var buffer = Memory.alloc(BUFSIZE);
        read(foldmodule, buffer, BUFSIZE);

        var fileoffset = 0;
        var filesize = 0;
        magic = buffer.readU32();
        if (magic === FAT_CIGAM || magic === FAT_MAGIC) {
            var off = 4;
            var archs = swap32(buffer.add(off).readU32());
            for (var i = 0; i < archs; i++) {
                var cputype = swap32(buffer.add(off + 4).readU32());
                var cpusubtype = swap32(buffer.add(off + 8).readU32());
                if (cur_cpu_type === cputype && cur_cpu_subtype === cpusubtype) {
                    fileoffset = swap32(buffer.add(off + 12).readU32());
                    filesize = swap32(buffer.add(off + 16).readU32());
                    break;
                }
                off += 20;
            }
            if (fileoffset === 0 || filesize === 0) {
                close(fmodule);
                close(foldmodule);
                return "fat slice not found";
            }
            lseek(fmodule, 0, SEEK_SET);
            lseek(foldmodule, fileoffset, SEEK_SET);
            for (var i = 0; i < parseInt(filesize / BUFSIZE); i++) {
                read(foldmodule, buffer, BUFSIZE);
                write(fmodule, buffer, BUFSIZE);
            }
            if (filesize % BUFSIZE) {
                read(foldmodule, buffer, filesize % BUFSIZE);
                write(fmodule, buffer, filesize % BUFSIZE);
            }
        } else {
            var readLen = 0;
            lseek(foldmodule, 0, SEEK_SET);
            lseek(fmodule, 0, SEEK_SET);
            while (readLen = read(foldmodule, buffer, BUFSIZE)) {
                write(fmodule, buffer, readLen);
            }
        }

        var ncmds = modbase.add(16).readU32();
        var off = size_of_mach_header;
        var offset_cryptid = -1;
        var crypt_off = 0;
        var crypt_size = 0;
        for (var i = 0; i < ncmds; i++) {
            var cmd = modbase.add(off).readU32();
            var cmdsize = modbase.add(off + 4).readU32();
            if (cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) {
                offset_cryptid = off + 16;
                crypt_off = modbase.add(off + 8).readU32();
                crypt_size = modbase.add(off + 12).readU32();
            }
            off += cmdsize;
        }

        if (offset_cryptid !== -1) {
            var tpbuf = Memory.alloc(8);
            tpbuf.writeU64(0);
            lseek(fmodule, offset_cryptid, SEEK_SET);
            write(fmodule, tpbuf, 4);
            if (crypt_size > 0) {
                lseek(fmodule, crypt_off, SEEK_SET);
                write(fmodule, modbase.add(crypt_off), crypt_size);
            }
        }

        close(fmodule);
        close(foldmodule);
        return null;
    }

    function main() {
        var home = getenvStr("HOME");
        if (home === null) {
            writeTextFile("/tmp/unfair-frida-status", "error: HOME missing");
            return;
        }

        var configPath = home + "/Documents/unfair-frida/config.json";
        var raw = readTextFile(configPath);
        if (raw === null || raw === "") {
            writeTextFile(home + "/Documents/unfair-frida/status", "error: config missing");
            return;
        }

        var config;
        try {
            config = JSON.parse(raw);
        } catch (e) {
            writeTextFile(home + "/Documents/unfair-frida/status", "error: bad config " + e);
            return;
        }

        var image = config.image || "";
        var output = config.output || "";
        var status = config.status || home + "/Documents/unfair-frida/status";
        if (image === "" || output === "") {
            writeTextFile(status, "error: image/output missing");
            return;
        }

        var error = dumpModule(image, output);
        if (error !== null) {
            writeTextFile(status, "error: " + error);
            return;
        }
        writeTextFile(status, "ok");
    }

    try {
        main();
    } catch (e) {
        var home = getenvStr("HOME");
        if (home !== null) {
            try {
                writeTextFile(home + "/Documents/unfair-frida/status", "error: " + e);
            } catch (_) { }
        }
    }
})();
