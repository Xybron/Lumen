#include <CoreAudio/AudioServerPlugIn.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <unistd.h>
#include <cassert>
#include <cstring>
#include <iostream>

template<class T> T property(AudioServerPlugInDriverRef driver, AudioObjectID object, UInt32 selector,
    UInt32 scope = kAudioObjectPropertyScopeGlobal) {
    AudioObjectPropertyAddress address{selector, scope, kAudioObjectPropertyElementMain};
    T value{}; UInt32 size = sizeof(value);
    assert((*driver)->GetPropertyData(driver, object, getpid(), &address, 0, nullptr, size, &size, &value) == noErr);
    assert(size == sizeof(value)); return value;
}
int main(int argc, char** argv) {
    assert(argc == 2);
    auto library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { std::cerr << dlerror() << '\n'; return 1; }
    auto factory = reinterpret_cast<void*(*)(CFAllocatorRef, CFUUIDRef)>(dlsym(library, "LumenAudioFactory"));
    assert(factory);
    auto driver = static_cast<AudioServerPlugInDriverRef>(factory(kCFAllocatorDefault, kAudioServerPlugInTypeUUID));
    AudioServerPlugInHostInterface host{};
    host.PropertiesChanged = [](AudioServerPlugInHostRef, AudioObjectID, UInt32, const AudioObjectPropertyAddress*) { return OSStatus(noErr); };
    assert(driver); assert((*driver)->Initialize(driver, &host) == noErr);
    auto device = property<AudioObjectID>(driver, kAudioObjectPlugInObject, kAudioPlugInPropertyDeviceList);
    auto name = property<CFStringRef>(driver, device, kAudioObjectPropertyName);
    assert(CFEqual(name, CFSTR("Lumen Microphone"))); CFRelease(name);
    auto uid = property<CFStringRef>(driver, device, kAudioDevicePropertyDeviceUID);
    assert(CFEqual(uid, CFSTR("app.lumen.studio.audio"))); CFRelease(uid);
    auto input = property<AudioObjectID>(driver, device, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput);
    auto output = property<AudioObjectID>(driver, device, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput);
    assert(input != output);
    auto format = property<AudioStreamBasicDescription>(driver, input, kAudioStreamPropertyPhysicalFormat);
    assert(format.mSampleRate == 48000 && format.mChannelsPerFrame == 2 && format.mBytesPerFrame == 8);
    assert(format.mFormatFlags & kAudioFormatFlagIsFloat);
    assert((*driver)->StartIO(driver, device, 1) == noErr);
    float expected[] = {0.2f, -0.3f, 0.4f, -0.5f}, result[4] = {};
    AudioServerPlugInIOCycleInfo cycle{};
    cycle.mOutputTime.mSampleTime = 4096;
    cycle.mInputTime.mSampleTime = 4096 + 1024;
    assert((*driver)->DoIOOperation(driver, device, output, 1, kAudioServerPlugInIOOperationWriteMix, 2, &cycle, expected, nullptr) == noErr);
    assert((*driver)->DoIOOperation(driver, device, input, 2, kAudioServerPlugInIOOperationReadInput, 2, &cycle, result, nullptr) == noErr);
    assert(memcmp(result, expected, sizeof(result)) == 0);
    std::memset(result, 0, sizeof(result));
    assert((*driver)->DoIOOperation(driver, device, input, 3, kAudioServerPlugInIOOperationReadInput, 2, &cycle, result, nullptr) == noErr);
    assert(memcmp(result, expected, sizeof(result)) == 0);
    cycle.mInputTime.mSampleTime += 2;
    assert((*driver)->DoIOOperation(driver, device, input, 2, kAudioServerPlugInIOOperationReadInput, 2, &cycle, result, nullptr) == noErr);
    for (auto value : result) assert(value == 0);
    assert((*driver)->StopIO(driver, device, 1) == noErr);
    std::cout << "HAL plugin: device discovery, stereo format, loopback IO, multiple clients and silence passed\n";
    // The plugin owns process-lifetime CoreAudio objects; leave unloading to exit.
}
