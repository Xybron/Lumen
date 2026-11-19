#pragma once
#include <stdint.h>

namespace lumen {
// POD storage: usable in the nonpaged driver data section, with no CRT startup,
// allocation, floating point or STL. Callers serialize with the driver's lock.
struct Loopback {
    static constexpr uint64_t capacity = 16384;
    static constexpr uint64_t noReader = UINT64_MAX;
    static constexpr uint64_t delay = 960; // 20 ms at 48 kHz
    uint32_t frames[capacity]; // two packed signed 16-bit samples
    uint64_t written;
    uint64_t lastWrite100ns;

    void write(const unsigned char* bytes, uint32_t count, uint64_t now100ns) {
        for (uint32_t i = 0; i < count; ++i) {
            const auto p = bytes + i * 4;
            frames[(written + i) % capacity] = uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
        }
        written += count;
        lastWrite100ns = now100ns;
    }
    void read(unsigned char* output, uint32_t count, uint64_t& cursor, uint64_t now100ns) const {
        // A disconnected writer never replays an old tail on a later capture.
        if (!lastWrite100ns || now100ns - lastWrite100ns > 1500000) cursor = noReader;
        if (cursor == noReader && lastWrite100ns && now100ns - lastWrite100ns <= 1500000)
            cursor = written > delay ? written - delay : 0;
        if (cursor != noReader && (cursor > written || written - cursor > 4096))
            cursor = written > delay ? written - delay : 0;
        for (uint32_t i = 0; i < count; ++i) {
            uint32_t packed = 0;
            if (cursor != noReader && cursor < written) packed = frames[cursor++ % capacity];
            // Microphone WaveRT format is signed 32-bit stereo PCM.
            uint32_t left = (packed & 0xffffu) << 16, right = packed & 0xffff0000u;
            auto p = output + i * 8;
            for (unsigned b = 0; b < 4; ++b) { p[b] = (unsigned char)(left >> (b * 8)); p[b + 4] = (unsigned char)(right >> (b * 8)); }
        }
    }
};
}
