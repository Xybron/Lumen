#import <Foundation/Foundation.h>
#import <CoreMediaIO/CoreMediaIO.h>
#import <AudioToolbox/AudioToolbox.h>
#include "AudioRing.hpp"
#include <vector>
#include <cstdio>
#include <unistd.h>
#include <cerrno>

static CFStringRef const cameraUID = CFSTR("0AD8C8C2-C85C-4DCF-AFA9-70415819E240");
static CFStringRef const audioUID = CFSTR("app.lumen.studio.audio");
static constexpr uint32_t width = 1280, height = 720, frameBytes = width * height * 4;

static void report(NSDictionary* object) {
    NSData* json = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void check(OSStatus status, const char* operation) {
    if (status != noErr) throw std::runtime_error(std::string(operation) + " (" + std::to_string(status) + ")");
}
static AudioDeviceID audioDevice() {
    AudioDeviceID device = kAudioObjectUnknown;
    CFStringRef uid = audioUID;
    AudioValueTranslation translation{&uid, sizeof(uid), &device, sizeof(device)};
    AudioObjectPropertyAddress address{kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 size = sizeof(translation);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &translation)) return kAudioObjectUnknown;
    return device;
}
static CMIODeviceID cameraDevice() {
    // Include non-physical devices in the legacy CMIO device listing.
    UInt32 allow = 1;
    CMIOObjectPropertyAddress allowAddress{kCMIOHardwarePropertyAllowScreenCaptureDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
    CMIOObjectSetPropertyData(kCMIOObjectSystemObject, &allowAddress, 0, nullptr, sizeof(allow), &allow);
    CMIOObjectPropertyAddress address{kCMIOHardwarePropertyDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
    UInt32 size = 0;
    if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &address, 0, nullptr, &size)) return 0;
    std::vector<CMIODeviceID> devices(size / sizeof(CMIODeviceID));
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &address, 0, nullptr, size, &size, devices.data())) return 0;
    for (auto device : devices) {
        CFStringRef uid = nullptr;
        address.mSelector = kCMIODevicePropertyDeviceUID;
        size = sizeof(uid);
        if (!CMIOObjectGetPropertyData(device, &address, 0, nullptr, size, &size, &uid) && uid) {
            bool matches = CFStringCompare(uid, cameraUID, kCFCompareCaseInsensitive) == kCFCompareEqualTo;
            CFRelease(uid);
            if (matches) return device;
        }
    }
    return 0;
}
static CMIOStreamID sinkStream(CMIODeviceID device) {
    CMIOObjectPropertyAddress address{kCMIODevicePropertyStreams, kCMIODevicePropertyScopeOutput, kCMIOObjectPropertyElementMain};
    UInt32 size = 0;
    check(CMIOObjectGetPropertyDataSize(device, &address, 0, nullptr, &size), "Find camera input");
    std::vector<CMIOStreamID> streams(size / sizeof(CMIOStreamID));
    check(CMIOObjectGetPropertyData(device, &address, 0, nullptr, size, &size, streams.data()), "Read camera streams");
    if (streams.size() != 1) throw std::runtime_error("Lumen camera input is unavailable");
    return streams[0];
}

class ProgramOutput {
    AudioUnit audio = nullptr;
    CMIODeviceID device = 0;
    CMIOStreamID stream = 0;
    CMSimpleQueueRef queue = nullptr;
    CVPixelBufferPoolRef pool = nullptr;
    CMVideoFormatDescriptionRef format = nullptr;
    bool streaming = false;
    lumen::AudioFIFO audioFIFO;
    static OSStatus render(void* context, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32,
        UInt32 frames, AudioBufferList* output) {
        auto self = static_cast<ProgramOutput*>(context);
        if (output->mNumberBuffers != 1 || output->mBuffers[0].mDataByteSize < frames * 8) return kAudio_ParamError;
        self->audioFIFO.pop(static_cast<float*>(output->mBuffers[0].mData), frames);
        return noErr;
    }
public:
    void start() {
        auto audioID = audioDevice();
        device = cameraDevice();
        if (!audioID || !device) throw std::runtime_error("Install and enable both Lumen devices before starting");
        stream = sinkStream(device);
        check(CMIOStreamCopyBufferQueue(stream, nullptr, nullptr, &queue), "Open camera queue");
        check(CMVideoFormatDescriptionCreate(kCFAllocatorDefault, kCVPixelFormatType_32BGRA, width, height, nullptr, &format), "Create video format");
        NSDictionary* attributes = @{
            (NSString*)kCVPixelBufferWidthKey: @(width), (NSString*)kCVPixelBufferHeightKey: @(height),
            (NSString*)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
            (NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{}
        };
        check(CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr, (__bridge CFDictionaryRef)attributes, &pool), "Create camera buffers");
        check(CMIODeviceStartStream(device, stream), "Start camera input");
        streaming = true;
        AudioComponentDescription description{kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0};
        auto component = AudioComponentFindNext(nullptr, &description);
        if (!component) throw std::runtime_error("CoreAudio output is unavailable");
        check(AudioComponentInstanceNew(component, &audio), "Create audio output");
        UInt32 enabled = 1;
        check(AudioUnitSetProperty(audio, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enabled, sizeof(enabled)), "Enable audio output");
        check(AudioUnitSetProperty(audio, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &audioID, sizeof(audioID)), "Select Lumen audio");
        AudioStreamBasicDescription audioFormat{48000, kAudioFormatLinearPCM,
            kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian, 8, 1, 8, 2, 32, 0};
        check(AudioUnitSetProperty(audio, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &audioFormat, sizeof(audioFormat)), "Set audio format");
        AURenderCallbackStruct callback{render, this};
        check(AudioUnitSetProperty(audio, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &callback, sizeof(callback)), "Set audio callback");
        check(AudioUnitInitialize(audio), "Initialize audio");
        check(AudioOutputUnitStart(audio), "Start audio");
    }
    bool video(const uint8_t* bytes) {
        if (!queue || CMSimpleQueueGetFullness(queue) >= 1) return false;
        CVPixelBufferRef pixel = nullptr;
        check(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixel), "Allocate frame");
        CVPixelBufferLockBaseAddress(pixel, 0);
        auto destination = static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(pixel));
        for (uint32_t y = 0; y < height; ++y) memcpy(destination + y * CVPixelBufferGetBytesPerRow(pixel), bytes + y * width * 4, width * 4);
        CVPixelBufferUnlockBaseAddress(pixel, 0);
        CMSampleTimingInfo timing{CMTimeMake(1, 30), CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid};
        CMSampleBufferRef sample = nullptr;
        OSStatus status = CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pixel, true, nullptr, nullptr, format, &timing, &sample);
        CFRelease(pixel);
        check(status, "Create frame sample");
        // The sink consumes the retained sample on successful enqueue.
        status = CMSimpleQueueEnqueue(queue, sample);
        if (status) CFRelease(sample);
        return status == noErr;
    }
    bool sound(const uint8_t* bytes, uint32_t size) { return audioFIFO.push(reinterpret_cast<const float*>(bytes), size / 8); }
    ~ProgramOutput() {
        if (audio) { AudioOutputUnitStop(audio); AudioUnitUninitialize(audio); AudioComponentInstanceDispose(audio); }
        if (streaming) CMIODeviceStopStream(device, stream);
        if (queue) CFRelease(queue);
        if (pool) CFRelease(pool);
        if (format) CFRelease(format);
    }
};

static bool readExact(void* bytes, size_t size) {
    auto p = static_cast<uint8_t*>(bytes);
    while (size) {
        ssize_t count = read(STDIN_FILENO, p, size);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return false;
        p += count; size -= count;
    }
    return true;
}
int main(int argc, const char* argv[]) {
    @autoreleasepool {
        NSString* command = argc == 2 ? @(argv[1]) : @"";
        if ([command isEqualToString:@"status"]) {
            report(@{@"camera": @(cameraDevice() != 0), @"microphone": @(audioDevice() != 0)}); return 0;
        }
        if (![command isEqualToString:@"stream"]) { report(@{@"error": @"Unknown device command"}); return 1; }
        try {
            ProgramOutput output;
            output.start();
            report(@{@"state": @"ready"});
            std::vector<uint8_t> payload(frameBytes);
            // LE header: magic LUM1, type (1=BGRA, 2=float32 stereo), payload length.
            uint32_t header[3];
            while (readExact(header, sizeof(header))) {
                uint32_t type = header[1], size = header[2];
                if (header[0] != 0x314d554c || !((type == 1 && size == frameBytes) || (type == 2 && size > 0 && size <= 32768 && size % 8 == 0)))
                    throw std::runtime_error("Invalid media packet");
                if (!readExact(payload.data(), size)) throw std::runtime_error("Incomplete media packet");
                bool accepted = type == 1 ? output.video(payload.data()) : output.sound(payload.data(), size);
                report(@{@"ack": @(type), @"accepted": @(accepted)});
            }
            return 0;
        } catch (const std::exception& error) {
            report(@{@"error": @(error.what())}); return 1;
        }
    }
}
