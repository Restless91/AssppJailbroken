#ifndef UNFAIR_DAEMON_SUPPORT_H
#define UNFAIR_DAEMON_SUPPORT_H

#include <stddef.h>
#include <stdint.h>

int unfaird_raise_jetsam_limit(int32_t megabytes, char *error, size_t error_size);
int unfaird_get_jetsam_limits(int32_t *active_megabytes, int32_t *inactive_megabytes, char *error, size_t error_size);

#endif
