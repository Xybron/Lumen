#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>
#include <node_api.h>
#include <string>
#include <memory>

@interface LumenActivation : NSObject <OSSystemExtensionRequestDelegate>
@property(nonatomic) napi_threadsafe_function callback;
@end
static LumenActivation* active;
@implementation LumenActivation
- (void)emit:(NSString*)message finished:(BOOL)finished {
    if (!self.callback) return;
    auto text = new std::string(message.UTF8String);
    if (napi_call_threadsafe_function(self.callback, text, napi_tsfn_nonblocking) != napi_ok) delete text;
    if (finished) {
        napi_release_threadsafe_function(self.callback, napi_tsfn_release);
        self.callback = nullptr;
        active = nil;
    }
}
- (void)requestNeedsUserApproval:(OSSystemExtensionRequest*)request { [self emit:@"approval-required" finished:NO]; }
- (void)request:(OSSystemExtensionRequest*)request didFinishWithResult:(OSSystemExtensionRequestResult)result {
    [self emit:result == OSSystemExtensionRequestCompleted ? @"activated" : @"restart-required" finished:YES];
}
- (void)request:(OSSystemExtensionRequest*)request didFailWithError:(NSError*)error {
    [self emit:[@"error:" stringByAppendingString:error.localizedDescription] finished:YES];
}
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest*)request
    actionForReplacingExtension:(OSSystemExtensionProperties*)existing withExtension:(OSSystemExtensionProperties*)replacement {
    return OSSystemExtensionReplacementActionReplace;
}
@end

static void deliver(napi_env env, napi_value callback, void*, void* data) {
    std::unique_ptr<std::string> message(static_cast<std::string*>(data));
    if (!env || !callback) return;
    napi_value text, receiver;
    napi_create_string_utf8(env, message->data(), message->size(), &text);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &text, nullptr);
}
static napi_value request(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2], result;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    napi_valuetype type;
    if (count != 2 || napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, nullptr, "Expected operation and callback"); return nullptr;
    }
    char command[16]; size_t length;
    if (napi_get_value_string_utf8(env, args[0], command, sizeof(command), &length) != napi_ok ||
        (strcmp(command, "activate") && strcmp(command, "deactivate"))) {
        napi_throw_type_error(env, nullptr, "Invalid camera operation"); return nullptr;
    }
    if (active) { napi_throw_error(env, nullptr, "Camera approval is already pending"); return nullptr; }
    LumenActivation* delegate = [LumenActivation new];
    napi_value name;
    napi_create_string_utf8(env, "LumenCameraActivation", NAPI_AUTO_LENGTH, &name);
    napi_threadsafe_function callback;
    if (napi_create_threadsafe_function(env, args[1], nullptr, name, 0, 1, nullptr, nullptr, nullptr, deliver, &callback) != napi_ok) return nullptr;
    delegate.callback = callback;
    active = delegate;
    bool activate = strcmp(command, "activate") == 0;
    dispatch_async(dispatch_get_main_queue(), ^{
        OSSystemExtensionRequest* request = activate
            ? [OSSystemExtensionRequest activationRequestForExtension:@"app.lumen.studio.camera" queue:dispatch_get_main_queue()]
            : [OSSystemExtensionRequest deactivationRequestForExtension:@"app.lumen.studio.camera" queue:dispatch_get_main_queue()];
        request.delegate = delegate;
        [OSSystemExtensionManager.sharedManager submitRequest:request];
    });
    napi_get_undefined(env, &result);
    return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "request", NAPI_AUTO_LENGTH, request, nullptr, &function);
    napi_set_named_property(env, exports, "request", function);
    return exports;
}
NAPI_MODULE(lumen_devices, initialize)
