#ifndef UNFAIR_DAEMON_SUPPORT_H
#define UNFAIR_DAEMON_SUPPORT_H

#include <stddef.h>
#include <stdint.h>

int unfaird_raise_jetsam_limit(int32_t megabytes, char *error, size_t error_size);
int unfaird_inflate_raw(
    const uint8_t *source,
    size_t source_size,
    uint8_t *destination,
    size_t destination_size,
    size_t *written,
    char *error,
    size_t error_size
);

#endif
