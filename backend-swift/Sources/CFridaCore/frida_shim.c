// frida_shim.c — Thin C bridge from unfaird Swift to frida-core
// Links against libfrida-core.a from frida-core-devkit
#include "include/frida-core.h"
#include "include/frida_shim.h"
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

// Context holds all frida-core state
struct FridaShimContext {
    FridaDeviceManager *manager;
    FridaDevice *device;
    FridaSession *session;
    FridaScript *script;
    GMainContext *main_ctx;
    GMainLoop *main_loop;
    pthread_t main_thread;

    // Message callback
    FridaMessageCallback message_cb;
    void *message_user_data;

    // Auth state
    bool authenticated;

    // Last error
    char *last_error;
};

// Forward declarations
static void on_message(FridaScript *script, const gchar *message, GBytes *data, gpointer user_data);
static void *main_loop_thread(void *arg);
static void set_error(FridaShimContext *ctx, const GError *error);

FridaShimContext* frida_shim_init(const char* host) {
    frida_init();

    FridaShimContext *ctx = calloc(1, sizeof(FridaShimContext));
    if (!ctx) return NULL;

    ctx->manager = frida_device_manager_new();
    if (!ctx->manager) {
        free(ctx);
        return NULL;
    }

    // Connect to frida-server
    GError *error = NULL;
    ctx->device = frida_device_manager_add_remote_device_sync(
        ctx->manager, host, NULL, NULL, &error
    );
    if (error) {
        set_error(ctx, error);
        g_error_free(error);
        frida_shim_destroy(ctx);
        return NULL;
    }

    return ctx;
}

void frida_shim_destroy(FridaShimContext* ctx) {
    if (!ctx) return;

    if (ctx->script) {
        frida_script_unload_sync(ctx->script, NULL, NULL);
        g_object_unref(ctx->script);
    }
    if (ctx->session) {
        frida_session_detach_sync(ctx->session, NULL, NULL);
        g_object_unref(ctx->session);
    }
    if (ctx->device) {
        g_object_unref(ctx->device);
    }
    if (ctx->manager) {
        frida_device_manager_close_sync(ctx->manager, NULL, NULL);
        g_object_unref(ctx->manager);
    }

    free(ctx->last_error);
    free(ctx);
}

int frida_shim_get_app_pid(FridaShimContext* ctx, const char* bundle_id, char** out_error) {
    if (!ctx || !ctx->device) {
        if (out_error) *out_error = strdup("device not connected");
        return -1;
    }

    GError *error = NULL;
    FridaApplicationList *apps = frida_device_enumerate_applications_sync(
        ctx->device, NULL, NULL, &error
    );
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return -1;
    }

    int pid = 0;
    int count = frida_application_list_size(apps);
    for (int i = 0; i < count; i++) {
        FridaApplication *app = frida_application_list_get(apps, i);
        const char *identifier = frida_application_get_identifier(app);
        if (identifier && strcmp(identifier, bundle_id) == 0) {
            pid = frida_application_get_pid(app);
            g_object_unref(apps);
            return pid;
        }
    }

    g_object_unref(apps);
    return 0;
}

int frida_shim_spawn_app(FridaShimContext* ctx, const char* bundle_id, char** out_error) {
    if (!ctx || !ctx->device) {
        if (out_error) *out_error = strdup("device not connected");
        return -1;
    }

    GError *error = NULL;
    guint pid = frida_device_spawn_sync(ctx->device, bundle_id, NULL, NULL, &error);
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return -1;
    }

    return (int)pid;
}

bool frida_shim_resume_app(FridaShimContext* ctx, int pid, char** out_error) {
    if (!ctx || !ctx->device) return false;

    GError *error = NULL;
    frida_device_resume_sync(ctx->device, (guint)pid, NULL, &error);
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    return true;
}

bool frida_shim_attach(FridaShimContext* ctx, int pid, char** out_error) {
    if (!ctx || !ctx->device) {
        if (out_error) *out_error = strdup("device not connected");
        return false;
    }

    if (ctx->session) {
        frida_session_detach_sync(ctx->session, NULL, NULL);
        g_object_unref(ctx->session);
        ctx->session = NULL;
    }

    GError *error = NULL;
    ctx->session = frida_device_attach_sync(ctx->device, (guint)pid, NULL, NULL, &error);
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    return true;
}

bool frida_shim_detach(FridaShimContext* ctx, char** out_error) {
    if (!ctx || !ctx->session) return true;

    GError *error = NULL;
    frida_session_detach_sync(ctx->session, NULL, &error);
    g_object_unref(ctx->session);
    ctx->session = NULL;

    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    return true;
}

bool frida_shim_load_script(FridaShimContext* ctx, const char* js_source, char** out_error) {
    if (!ctx || !ctx->session) {
        if (out_error) *out_error = strdup("not attached to process");
        return false;
    }

    if (ctx->script) {
        frida_script_unload_sync(ctx->script, NULL, NULL);
        g_object_unref(ctx->script);
        ctx->script = NULL;
    }

    GError *error = NULL;
    ctx->script = frida_session_create_script_sync(
        ctx->session, js_source, NULL, NULL, &error
    );
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    // Connect message signal
    g_signal_connect(ctx->script, "message", G_CALLBACK(on_message), ctx);

    frida_script_load_sync(ctx->script, NULL, &error);
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    return true;
}

bool frida_shim_unload_script(FridaShimContext* ctx, char** out_error) {
    if (!ctx || !ctx->script) return true;

    GError *error = NULL;
    frida_script_unload_sync(ctx->script, NULL, &error);
    g_object_unref(ctx->script);
    ctx->script = NULL;

    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return false;
    }

    return true;
}

void frida_shim_set_message_callback(FridaShimContext* ctx, FridaMessageCallback callback, void* user_data) {
    if (!ctx) return;
    ctx->message_cb = callback;
    ctx->message_user_data = user_data;
}

char* frida_shim_list_apps(FridaShimContext* ctx, char** out_error) {
    if (!ctx || !ctx->device) return NULL;

    GError *error = NULL;
    FridaApplicationList *apps = frida_device_enumerate_applications_sync(
        ctx->device, NULL, NULL, &error
    );
    if (error) {
        if (out_error) *out_error = strdup(error->message);
        g_error_free(error);
        return NULL;
    }

    // Build JSON array
    GString *json = g_string_new("[");
    int count = frida_application_list_size(apps);
    for (int i = 0; i < count; i++) {
        FridaApplication *app = frida_application_list_get(apps, i);
        gchar *escaped_name = g_strescape(frida_application_get_name(app), NULL);
        gchar *escaped_id = g_strescape(frida_application_get_identifier(app), NULL);
        g_string_append_printf(json, "%s{\"pid\":%d,\"name\":\"%s\",\"identifier\":\"%s\"}",
            i > 0 ? "," : "",
            frida_application_get_pid(app),
            escaped_name,
            escaped_id
        );
        g_free(escaped_name);
        g_free(escaped_id);
    }
    g_string_append(json, "]");

    g_object_unref(apps);
    return g_string_free(json, FALSE);
}

void frida_shim_free_string(char* str) {
    g_free(str);
}

void frida_shim_free_buffer(uint8_t* buf) {
    g_free(buf);
}

// Signal handler for script messages
static void on_message(FridaScript *script, const gchar *message, GBytes *data, gpointer user_data) {
    FridaShimContext *ctx = (FridaShimContext *)user_data;
    if (!ctx || !ctx->message_cb) return;

    const void *data_ptr = NULL;
    int data_len = 0;
    if (data) {
        gsize size;
        data_ptr = g_bytes_get_data(data, &size);
        data_len = (int)size;
    }

    ctx->message_cb(message, data_ptr, data_len, ctx->message_user_data);
}

static void set_error(FridaShimContext* ctx, const GError *error) {
    if (ctx->last_error) {
        free(ctx->last_error);
    }
    ctx->last_error = error ? strdup(error->message) : NULL;
}
