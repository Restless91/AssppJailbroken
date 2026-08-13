// frida-server-dump-agent.js - Frida 17 server-based dump for unfaird fallback
// Reads __UNFAIR_FRIDA_CONFIG__ embedded by frida-server-dump.py, dumps the
// requested Mach-O image from process memory with decrypted crypt pages,
// patches cryptid to 0, and sends "ok" / "error:..." back via send().
(function () {
    'use strict';

    var O_RDONLY = 0;
    var O_WRONLY = 1;
    var O_RDWR   = 2;
    var O_CREAT  = 512;
    var SEEK_SET = 0;
    var SEEK_CUR = 1;
    var SEEK_END = 2;

    var FAT_MAGIC   = 0xcafebabe;
    var FAT_CIGAM   = 0xbebafeca;
    var MH_MAGIC    = 0xfeedface;
    var MH_CIGAM    = 0xcefaedfe;
    var MH_MAGIC_64 = 0xfeedfacf;
    var MH_CIGAM_64 = 0xcffaedfe;

    var LC_ENCRYPTION_INFO    = 0x21;
    var LC_ENCRYPTION_INFO_64 = 0x2C;

    // --- Native helpers ---
    function nfunc(name, ret, args) {
        return new NativeFunction(Module.getExportByName(null, name), ret, args);
    }

    var _open   = nfunc("open",   "int",   ["pointer", "int", "int"]);
    var _read   = nfunc("read",   "ssize_t", ["int", "pointer", "size_t"]);
    var _write  = nfunc("write",  "ssize_t", ["int", "pointer", "size_t"]);
    var _lseek  = nfunc("lseek",  "off_t", ["int", "off_t", "int"]);
    var _close  = nfunc("close",  "int",   ["int"]);
    var _remove = nfunc("remove", "int",   ["pointer"]);
    var _access = nfunc("access", "int",   ["pointer", "int"]);

    function openFile(pathname, flags, mode) {
        return _open(Memory.allocUtf8String(pathname), flags, mode);
    }

    function fileExists(pathname) {
        return _access(Memory.allocUtf8String(pathname), 0 /* F_OK */) === 0;
    }

    function removeFile(pathname) {
        return _remove(Memory.allocUtf8String(pathname));
    }

    // --- Utility ---
    function swap32(value) {
        var s = value.toString(16);
        s = ("00000000" + s).slice(-8);
        var result = "";
        for (var i = 0; i < s.length; i += 2) {
            result = s.charAt(i) + s.charAt(i + 1) + result;
        }
        return parseInt(result, 16);
    }

    // --- Module lookup ---
    function findModule(imagePath) {
        var mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) {
            var target = mods[i].path;
            if (target === imagePath ||
                target.endsWith("/" + imagePath) ||
                target.endsWith(imagePath)) {
                return mods[i];
            }
        }
        return null;
    }

    // --- Core dump logic ---
    function dumpModule(imagePath, outputPath) {
        var mod = findModule(imagePath);
        if (mod === null) {
            return "module not loaded: " + imagePath;
        }

        var modbase = mod.base;

        // Remove stale output file
        if (fileExists(outputPath)) {
            removeFile(outputPath);
        }

        var fmodule   = openFile(outputPath,        O_CREAT | O_RDWR, 0o644);
        var foldmodule = openFile(mod.path,          O_RDONLY,        0);
        if (fmodule === -1 || foldmodule === -1) {
            if (fmodule !== -1) _close(fmodule);
            if (foldmodule !== -1) _close(foldmodule);
            return "cannot open output files";
        }

        var BUFSIZE = 4096;
        var buffer  = Memory.alloc(BUFSIZE);

        // Determine arch slice from on-disk file (may be FAT)
        var magic        = modbase.readU32();
        var cur_cpu_type    = modbase.add(4).readU32();
        var cur_cpu_subtype = modbase.add(8).readU32();

        var size_of_mach_header = 0;
        if (magic === MH_MAGIC || magic === MH_CIGAM) {
            size_of_mach_header = 28;
        } else if (magic === MH_MAGIC_64 || magic === MH_CIGAM_64) {
            size_of_mach_header = 32;
        }

        // Read FAT header from disk
        _read(foldmodule, buffer, BUFSIZE);
        var diskMagic = buffer.readU32();
        var fileoffset  = 0;
        var filesize    = 0;

        if (diskMagic === FAT_CIGAM || diskMagic === FAT_MAGIC) {
            var off   = 4;
            var archs = swap32(buffer.add(off).readU32());
            for (var i = 0; i < archs; i++) {
                var cputype    = swap32(buffer.add(off + 4).readU32());
                var cpusubtype = swap32(buffer.add(off + 8).readU32());
                if (cur_cpu_type === cputype && cur_cpu_subtype === cpusubtype) {
                    fileoffset = swap32(buffer.add(off + 12).readU32());
                    filesize   = swap32(buffer.add(off + 16).readU32());
                    break;
                }
                off += 20;
            }
            if (fileoffset === 0 || filesize === 0) {
                _close(fmodule);
                _close(foldmodule);
                return "fat slice not found in on-disk binary";
            }

            // Copy the correct slice
            _lseek(fmodule, 0, SEEK_SET);
            _lseek(foldmodule, fileoffset, SEEK_SET);
            var blocks = Math.floor(filesize / BUFSIZE);
            for (var j = 0; j < blocks; j++) {
                _read(foldmodule, buffer, BUFSIZE);
                _write(fmodule, buffer, BUFSIZE);
            }
            var remainder = filesize % BUFSIZE;
            if (remainder > 0) {
                _read(foldmodule, buffer, remainder);
                _write(fmodule, buffer, remainder);
            }
        } else {
            // Non-FAT: copy entire file
            _lseek(foldmodule, 0, SEEK_SET);
            _lseek(fmodule, 0, SEEK_SET);
            var n;
            while ((n = _read(foldmodule, buffer, BUFSIZE)) > 0) {
                _write(fmodule, buffer, n);
            }
        }

        // Parse load commands to find encryption info
        var ncmds = modbase.add(16).readU32();
        var off_lc = size_of_mach_header;
        var offset_cryptid = -1;
        var crypt_off  = 0;
        var crypt_size = 0;
        var crypt_cmd  = 0;

        for (var k = 0; k < ncmds; k++) {
            var cmd     = modbase.add(off_lc).readU32();
            var cmdsize = modbase.add(off_lc + 4).readU32();
            if (cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) {
                offset_cryptid = off_lc + 16;
                crypt_off      = modbase.add(off_lc + 8).readU32();
                crypt_size     = modbase.add(off_lc + 12).readU32();
                crypt_cmd      = cmd;
                break;
            }
            off_lc += cmdsize;
        }

        // Patch cryptid and copy decrypted pages
        if (offset_cryptid !== -1) {
            // Patch cryptid to 0
            var zeroBuf = Memory.alloc(4);
            zeroBuf.writeU32(0);
            _lseek(fmodule, offset_cryptid, SEEK_SET);
            _write(fmodule, zeroBuf, 4);

            // Copy decrypted pages from memory
            if (crypt_size > 0) {
                var pageSize = 16384; // arm64e on iOS 17 can use 16K pages
                var remaining = crypt_size;
                var memPtr = modbase.add(crypt_off);
                var fileOff = crypt_off;
                var copyBuf = Memory.alloc(pageSize);

                while (remaining > 0) {
                    var chunk = Math.min(remaining, pageSize);
                    // Read from process memory (already decrypted by kernel)
                    copyBuf.writeByteArray(memPtr.readByteArray(chunk));
                    _lseek(fmodule, fileOff, SEEK_SET);
                    _write(fmodule, copyBuf, chunk);
                    memPtr = memPtr.add(chunk);
                    fileOff += chunk;
                    remaining -= chunk;
                }
            }
        }

        _close(fmodule);
        _close(foldmodule);
        return null; // success
    }

    // --- Main ---
    function main() {
        var config = __UNFAIR_FRIDA_CONFIG__;
        if (!config) {
            send("error: missing __UNFAIR_FRIDA_CONFIG__");
            return;
        }

        var image  = config.image  || "";
        var output = config.output || "";
        var status = config.status || "";

        if (!image || !output) {
            send("error: config missing image/output fields");
            return;
        }

        var error = dumpModule(image, output);
        if (error !== null) {
            send("error: " + error);
            return;
        }
        send("ok");
    }

    // --- Entry ---
    try {
        main();
    } catch (e) {
        send("error: agent exception: " + e);
    }
})();
