#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>

namespace lumen {
// Absolute sample positions allow multiple readers to hear the same mix.
// Atomic samples and generation checks avoid torn stereo frames on wraparound.
class LoopbackRing {
    static constexpr size_t capacity = 32768;
    struct Slot {
        std::atomic<uint64_t> position{UINT64_MAX};
        std::atomic<uint64_t> samples{0};
    };
    std::array<Slot, capacity> slots;
public:
    static constexpr int latency = 1024;
    void clear() { for (auto& s : slots) s.position.store(UINT64_MAX); }
    void write(int64_t start, const float* data, size_t count) {
        for (size_t i = 0; i < count; ++i) {
            uint64_t p = start + i, bits;
            std::memcpy(&bits, data + 2 * i, sizeof(bits));
            auto& s = slots[p % capacity];
            s.position.store(UINT64_MAX);
            s.samples.store(bits);
            s.position.store(p);
        }
    }
    void read(int64_t start, float* data, size_t count) const {
        for (size_t i = 0; i < count; ++i) {
            int64_t p = start + i - latency;
            uint64_t bits = 0;
            if (p >= 0) {
                const auto& s = slots[p % capacity];
                auto before = s.position.load();
                bits = s.samples.load();
                if (before != uint64_t(p) || s.position.load() != before) bits = 0;
            }
            std::memcpy(data + 2 * i, &bits, sizeof(bits));
        }
    }
};

// One producer (the bridge pipe) and one real-time AudioUnit consumer.
// No allocation, locks or filesystem access on the audio thread.
class AudioFIFO {
    static constexpr uint64_t capacity = 16384;
    std::array<std::array<float, 2>, capacity> samples{};
    std::atomic<uint64_t> written{0}, readAt{0};
public:
    bool push(const float* data, size_t count) {
        auto w = written.load(std::memory_order_relaxed);
        auto r = readAt.load(std::memory_order_acquire);
        if (count > capacity || w - r + count > capacity) return false;
        for (size_t i = 0; i < count; ++i)
            std::memcpy(samples[(w + i) % capacity].data(), data + 2 * i, 2 * sizeof(float));
        written.store(w + count, std::memory_order_release);
        return true;
    }
    void pop(float* data, size_t count) {
        auto r = readAt.load(std::memory_order_relaxed);
        auto w = written.load(std::memory_order_acquire);
        // A stalled host must recover to live audio instead of replaying a backlog.
        if (w - r > 4096) r = w - 2048;
        size_t available = size_t(w - r) < count ? size_t(w - r) : count;
        for (size_t i = 0; i < available; ++i)
            std::memcpy(data + 2 * i, samples[(r + i) % capacity].data(), 2 * sizeof(float));
        std::memset(data + available * 2, 0, (count - available) * 2 * sizeof(float));
        readAt.store(r + available, std::memory_order_release);
    }
};
static_assert(std::atomic<uint64_t>::is_always_lock_free);
}
