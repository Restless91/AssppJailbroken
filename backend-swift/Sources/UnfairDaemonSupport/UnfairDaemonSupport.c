#include "UnfairDaemonSupport.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#define UNFAIRD_MEMORYSTATUS_CMD_SET_MEMLIMIT_PROPERTIES 7
#define UNFAIRD_MEMORYSTATUS_CMD_GET_MEMLIMIT_PROPERTIES 8

typedef struct unfaird_memlimit_properties {
    int32_t memlimit_active;
    uint32_t memlimit_active_attr;
    int32_t memlimit_inactive;
    uint32_t memlimit_inactive_attr;
} unfaird_memlimit_properties_t;

extern int memorystatus_control(unsigned int command, int pid, unsigned int flags, void *buffer, size_t buffersize);

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
#if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    int pid = getpid();
    unfaird_memlimit_properties_t properties = {
        .memlimit_active = megabytes,
        .memlimit_active_attr = 0,
        .memlimit_inactive = megabytes,
        .memlimit_inactive_attr = 0,
    };
    int result = memorystatus_control(
        UNFAIRD_MEMORYSTATUS_CMD_SET_MEMLIMIT_PROPERTIES,
        pid,
        0,
        &properties,
        sizeof(properties)
    );
    if (result != 0) {
        unfaird_set_error(error, error_size, "memorystatus set limit %d MB failed: %s", megabytes, strerror(errno));
        return -1;
    }

    int32_t active = 0;
    int32_t inactive = 0;
    if (unfaird_get_jetsam_limits(&active, &inactive, error, error_size) != 0) {
        return -1;
    }
    if (active != megabytes || inactive != megabytes) {
        unfaird_set_error(error, error_size, "memorystatus verification failed: requested %d MB, got active=%d MB inactive=%d MB", megabytes, active, inactive);
        return -1;
    }

    return 0;
#else
    (void)megabytes;
    (void)error;
    (void)error_size;
    return 0;
#endif
}

int unfaird_get_jetsam_limits(int32_t *active_megabytes, int32_t *inactive_megabytes, char *error, size_t error_size) {
#if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
    unfaird_memlimit_properties_t properties = {0};
    int result = memorystatus_control(
        UNFAIRD_MEMORYSTATUS_CMD_GET_MEMLIMIT_PROPERTIES,
        getpid(),
        0,
        &properties,
        sizeof(properties)
    );
    if (result != 0) {
        unfaird_set_error(error, error_size, "memorystatus get limit failed: %s", strerror(errno));
        return -1;
    }
    if (active_megabytes != NULL) *active_megabytes = properties.memlimit_active;
    if (inactive_megabytes != NULL) *inactive_megabytes = properties.memlimit_inactive;
    return 0;
#else
    if (active_megabytes != NULL) *active_megabytes = 0;
    if (inactive_megabytes != NULL) *inactive_megabytes = 0;
    (void)error;
    (void)error_size;
    return 0;
#endif
}
