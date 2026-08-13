#ifndef FRIDA_SHIM_H
#define FRIDA_SHIM_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle types for Swift
typedef struct FridaShimContext FridaShimContext;

// Create/destroy
FridaShimContext* frida_shim_init(const char* host);
void frida_shim_destroy(FridaShimContext* ctx);

// Device operations
int frida_shim_get_app_pid(FridaShimContext* ctx, const char* bundle_id, char** out_error);
int frida_shim_spawn_app(FridaShimContext* ctx, const char* bundle_id, char** out_error);
bool frida_shim_resume_app(FridaShimContext* ctx, int pid, char** out_error);
bool frida_shim_attach(FridaShimContext* ctx, int pid, char** out_error);
bool frida_shim_detach(FridaShimContext* ctx, char** out_error);

// Script operations
bool frida_shim_load_script(FridaShimContext* ctx, const char* js_source, char** out_error);
bool frida_shim_unload_script(FridaShimContext* ctx, char** out_error);

// Message handling (called from Swift thread)
typedef void (*FridaMessageCallback)(const char* json_message, const void* data, int data_len, void* user_data);
void frida_shim_set_message_callback(FridaShimContext* ctx, FridaMessageCallback callback, void* user_data);

// Memory dump (reads from remote process via Frida)
bool frida_shim_read_memory(FridaShimContext* ctx, const char* module_name,
                            uint8_t** out_data, uint64_t* out_size, char** out_error);

// List apps
char* frida_shim_list_apps(FridaShimContext* ctx, char** out_error);

// Free helper
void frida_shim_free_string(char* str);
void frida_shim_free_buffer(uint8_t* buf);

#ifdef __cplusplus
}
#endif

#endif /* FRIDA_SHIM_H */
