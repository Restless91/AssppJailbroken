#include <errno.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static void unfair_runtime_dump(void);

static void write_status(const char *path, const char *format, ...) {
    if (path == NULL || path[0] == '\0') {
        return;
    }

    FILE *file = fopen(path, "w");
    if (file == NULL) {
        return;
    }

    va_list args;
    va_start(args, format);
    vfprintf(file, format, args);
    va_end(args);
    fputc('\n', file);
    fclose(file);
}

static bool parse_uint_env(const char *name, uint64_t *value) {
    const char *raw = getenv(name);
    if (raw == NULL || raw[0] == '\0') {
        return false;
    }

    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(raw, &end, 0);
    if (errno != 0 || end == raw || *end != '\0') {
        return false;
    }

    *value = (uint64_t)parsed;
    return true;
}

static bool read_line_value(FILE *file, char *buffer, size_t buffer_size) {
    if (fgets(buffer, (int)buffer_size, file) == NULL) {
        return false;
    }
    buffer[strcspn(buffer, "\r\n")] = '\0';
    return true;
}

static bool read_runtime_config(char *output_path, size_t output_size, char *status_path, size_t status_size, uint64_t *file_offset, char *image_path, size_t image_size) {
    Dl_info image_info;
    if (dladdr((const void *)&unfair_runtime_dump, &image_info) == 0 || image_info.dli_fname == NULL) {
        return false;
    }

    char config_path[256];
    snprintf(config_path, sizeof(config_path), "%s.%d.conf", image_info.dli_fname, getpid());

    FILE *file = fopen(config_path, "r");
    if (file == NULL) {
        return false;
    }

    char offset_buffer[64];
    bool ok = read_line_value(file, output_path, output_size)
        && read_line_value(file, status_path, status_size)
        && read_line_value(file, offset_buffer, sizeof(offset_buffer))
        && read_line_value(file, image_path, image_size);
    fclose(file);
    if (!ok) {
        return false;
    }

    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(offset_buffer, &end, 0);
    if (errno != 0 || end == offset_buffer || *end != '\0') {
        return false;
    }
    *file_offset = (uint64_t)parsed;
    return true;
}

static bool same_path_suffix(const char *candidate, const char *expected) {
    if (candidate == NULL || expected == NULL) {
        return false;
    }
    if (strcmp(candidate, expected) == 0) {
        return true;
    }

    size_t candidate_len = strlen(candidate);
    size_t expected_len = strlen(expected);
    if (candidate_len < expected_len) {
        return false;
    }
    return strcmp(candidate + candidate_len - expected_len, expected) == 0;
}

static bool find_loaded_image(const char *image_path, const struct mach_header_64 **header, intptr_t *slide) {
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; i++) {
        const char *name = _dyld_get_image_name(i);
        if (!same_path_suffix(name, image_path)) {
            continue;
        }

        const struct mach_header *raw_header = _dyld_get_image_header(i);
        if (raw_header == NULL || raw_header->magic != MH_MAGIC_64) {
            continue;
        }

        *header = (const struct mach_header_64 *)raw_header;
        *slide = _dyld_get_image_vmaddr_slide(i);
        return true;
    }
    return false;
}

static const struct encryption_info_command_64 *find_encryption_info(const struct mach_header_64 *header, uint64_t *command_offset) {
    if (header == NULL || header->magic != MH_MAGIC_64) {
        return NULL;
    }

    const uint8_t *cursor = (const uint8_t *)header + sizeof(struct mach_header_64);
    uint64_t offset = sizeof(struct mach_header_64);
    for (uint32_t i = 0; i < header->ncmds; i++) {
        const struct load_command *command = (const struct load_command *)cursor;
        if (command->cmdsize < sizeof(struct load_command)) {
            return NULL;
        }

        if (command->cmd == LC_ENCRYPTION_INFO_64) {
            if (command->cmdsize < sizeof(struct encryption_info_command_64)) {
                return NULL;
            }
            if (command_offset != NULL) {
                *command_offset = offset;
            }
            return (const struct encryption_info_command_64 *)command;
        }

        cursor += command->cmdsize;
        offset += command->cmdsize;
    }

    return NULL;
}

static const void *memory_for_file_range(const struct mach_header_64 *header, intptr_t slide, uint64_t file_offset, uint64_t length) {
    const uint8_t *cursor = (const uint8_t *)header + sizeof(struct mach_header_64);
    for (uint32_t i = 0; i < header->ncmds; i++) {
        const struct load_command *command = (const struct load_command *)cursor;
        if (command->cmdsize < sizeof(struct load_command)) {
            return NULL;
        }

        if (command->cmd == LC_SEGMENT_64 && command->cmdsize >= sizeof(struct segment_command_64)) {
            const struct segment_command_64 *segment = (const struct segment_command_64 *)command;
            uint64_t segment_start = segment->fileoff;
            uint64_t segment_end = segment_start + segment->filesize;
            uint64_t requested_end = file_offset + length;
            if (file_offset >= segment_start && requested_end <= segment_end) {
                uint64_t delta = file_offset - segment_start;
                return (const void *)(segment->vmaddr + (uint64_t)slide + delta);
            }
        }

        cursor += command->cmdsize;
    }

    return NULL;
}

static void clear_code_signature(
    const struct mach_header_64 *header,
    uint64_t file_offset,
    int fd,
    uint64_t encryption_command_offset
) {
    (void)encryption_command_offset;
    const uint8_t *cursor = (const uint8_t *)header + sizeof(struct mach_header_64);
    uint64_t offset = sizeof(struct mach_header_64);
    for (uint32_t i = 0; i < header->ncmds; i++) {
        const struct load_command *command = (const struct load_command *)cursor;
        if (command->cmd == LC_CODE_SIGNATURE
            && command->cmdsize >= sizeof(struct linkedit_data_command)) {
            const struct linkedit_data_command *sig =
                (const struct linkedit_data_command *)command;
            if (sig->dataoff > 0 && sig->datasize > 0) {
                uint32_t zero_size = 0;
                pwrite(fd, &zero_size, sizeof(zero_size),
                    (off_t)(file_offset + offset + offsetof(struct linkedit_data_command, datasize)));
            }
            return;
        }
        cursor += command->cmdsize;
        offset += command->cmdsize;
    }
}

__attribute__((constructor))
static void unfair_runtime_dump(void) {
    char configured_output[1024];
    char configured_status[1024];
    char configured_image[1024];
    uint64_t configured_file_offset = 0;

    const char *output_path = getenv("UNFAIR_DUMP_OUTPUT");
    const char *status_path = getenv("UNFAIR_DUMP_STATUS");
    const char *image_path = getenv("UNFAIR_DUMP_IMAGE");
    bool has_config = read_runtime_config(
        configured_output,
        sizeof(configured_output),
        configured_status,
        sizeof(configured_status),
        &configured_file_offset,
        configured_image,
        sizeof(configured_image)
    );
    if (has_config) {
        output_path = configured_output;
        status_path = configured_status;
        image_path = configured_image;
    }
    if (output_path == NULL || output_path[0] == '\0') {
        return;
    }

    uint64_t file_offset = configured_file_offset;
    if (!has_config) {
        parse_uint_env("UNFAIR_DUMP_FILE_OFFSET", &file_offset);
    }

    const struct mach_header_64 *header = NULL;
    intptr_t slide = 0;
    if (!find_loaded_image(image_path, &header, &slide)) {
        void *handle = image_path == NULL ? NULL : dlopen(image_path, RTLD_LAZY | RTLD_GLOBAL);
        if (handle == NULL || !find_loaded_image(image_path, &header, &slide)) {
            const char *load_error = dlerror();
            write_status(
                status_path,
                "error: loaded image not found after dlopen: %s: %s",
                image_path ? image_path : "(null)",
                load_error ? load_error : "unknown error"
            );
            return;
        }
    }

    uint64_t command_offset = 0;
    const struct encryption_info_command_64 *info = find_encryption_info(header, &command_offset);
    if (info == NULL) {
        write_status(status_path, "error: encryption info missing");
        return;
    }
    if (info->cryptsize == 0) {
        write_status(status_path, "skipped: cryptid=%u cryptsize=%u", info->cryptid, info->cryptsize);
        return;
    }

    const void *source = memory_for_file_range(header, slide, info->cryptoff, info->cryptsize);
    if (source == NULL) {
        write_status(status_path, "error: encrypted memory range missing");
        return;
    }

    int fd = open(output_path, O_RDWR);
    if (fd < 0) {
        write_status(status_path, "error: open output failed: %s", strerror(errno));
        return;
    }

    off_t write_offset = (off_t)(file_offset + info->cryptoff);
    ssize_t written = pwrite(fd, source, info->cryptsize, write_offset);
    if (written != (ssize_t)info->cryptsize) {
        write_status(status_path, "error: pwrite decrypted bytes failed: %s", strerror(errno));
        close(fd);
        return;
    }

    uint32_t zero = 0;
    off_t cryptid_offset = (off_t)(file_offset + command_offset + offsetof(struct encryption_info_command_64, cryptid));
    written = pwrite(fd, &zero, sizeof(zero), cryptid_offset);
    if (written != (ssize_t)sizeof(zero)) {
        write_status(status_path, "error: pwrite cryptid failed: %s", strerror(errno));
        close(fd);
        return;
    }

    clear_code_signature(header, file_offset, fd, command_offset);
    fsync(fd);
    close(fd);
    write_status(status_path, "ok: wrote %u bytes at 0x%x (sig cleared)", info->cryptsize, info->cryptoff);
    return;
}
