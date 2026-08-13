#include "UnfairDaemonSupport.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <zlib.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

static void unfaird_set_error(char *error, size_t error_size, const char *format, ...) {
    if (error == NULL || error_size == 0) {
        return;
    }

    va_list args;
    va_start(args, format);
    vsnprintf(error, error_size, format, args);
    va_end(args);
}

int unfaird_raise_jetsam_limit(int32_t megabytes, char *error, size_t error_size) {
    /*
     * Do not call the private memorystatus_control commands here. On iOS 17
     * rootless environments those calls can corrupt launchd's memorystatus
     * bookkeeping and panic the device when a large package is processed.
     * Resource use is bounded by streaming I/O and downloader concurrency.
     */
    (void)megabytes;
    (void)error;
    (void)error_size;
    return 0;
}

int unfaird_inflate_raw(
    const uint8_t *source,
    size_t source_size,
    uint8_t *destination,
    size_t destination_size,
    size_t *written,
    char *error,
    size_t error_size
) {
    if (source == NULL || destination == NULL || written == NULL) {
        unfaird_set_error(error, error_size, "invalid inflate buffer");
        return -1;
    }

    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    stream.next_in = (Bytef *)source;
    stream.avail_in = (uInt)source_size;
    stream.next_out = destination;
    stream.avail_out = (uInt)destination_size;

    int status = inflateInit2(&stream, -MAX_WBITS);
    if (status != Z_OK) {
        unfaird_set_error(error, error_size, "inflateInit2 failed: %d", status);
        return -1;
    }

    status = inflate(&stream, Z_FINISH);
    *written = stream.total_out;
    inflateEnd(&stream);
    if (status != Z_STREAM_END) {
        unfaird_set_error(error, error_size, "inflate failed: %d", status);
        return -1;
    }
    return 0;
}
