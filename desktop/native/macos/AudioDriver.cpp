#include <aspl/Driver.hpp>
#include "AudioRing.hpp"

namespace {
class Loopback final : public aspl::ControlRequestHandler, public aspl::IORequestHandler {
    lumen::LoopbackRing ring;
public:
    OSStatus OnStartIO() override { ring.clear(); return noErr; }
    void OnReadClientInput(const std::shared_ptr<aspl::Client>&,
        const std::shared_ptr<aspl::Stream>&, Float64, Float64 time,
        void* bytes, UInt32 size) override {
        ring.read(int64_t(time), static_cast<float*>(bytes), size / (2 * sizeof(float)));
    }
    void OnWriteMixedOutput(const std::shared_ptr<aspl::Stream>&, Float64,
        Float64 time, const void* bytes, UInt32 size) override {
        ring.write(int64_t(time), static_cast<const float*>(bytes), size / (2 * sizeof(float)));
    }
};

std::shared_ptr<aspl::Driver> makeDriver() {
    auto context = std::make_shared<aspl::Context>();
    aspl::DeviceParameters params;
    params.Name = "Lumen Microphone";
    params.Manufacturer = "Lumen";
    params.DeviceUID = "app.lumen.studio.audio";
    params.ModelUID = "app.lumen.studio.audio.v1";
    params.SampleRate = 48000;
    params.ChannelCount = 2;
    params.CanBeDefault = false;
    params.CanBeDefaultForSystemSounds = false;
    params.ConfigurationApplicationBundleID = "app.lumen.studio";
    auto device = std::make_shared<aspl::Device>(context, params);
    aspl::StreamParameters stream;
    stream.Format = {48000, kAudioFormatLinearPCM,
        kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian,
        8, 1, 8, 2, 32, 0};
    stream.Direction = aspl::Direction::Input;
    stream.Latency = lumen::LoopbackRing::latency;
    device->AddStreamWithControlsAsync(stream);
    stream.Direction = aspl::Direction::Output;
    stream.Latency = 0;
    device->AddStreamWithControlsAsync(stream);
    auto handler = std::make_shared<Loopback>();
    device->SetControlHandler(handler);
    device->SetIOHandler(handler);
    auto plugin = std::make_shared<aspl::Plugin>(context);
    plugin->AddDevice(device);
    return std::make_shared<aspl::Driver>(context, plugin);
}
}

extern "C" __attribute__((visibility("default")))
void* LumenAudioFactory(CFAllocatorRef, CFUUIDRef type) {
    if (!CFEqual(type, kAudioServerPlugInTypeUUID)) return nullptr;
    static auto driver = makeDriver();
    return driver->GetReference();
}
