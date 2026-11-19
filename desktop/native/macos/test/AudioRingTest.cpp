#include "../AudioRing.hpp"
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

int main() {
    lumen::LoopbackRing ring;
    float source[] = {0.25f, -0.5f, 0.75f, -1.f}, result[4];
    ring.read(1024, result, 2);
    for (float v : result) assert(v == 0);
    ring.write(0, source, 2);
    ring.read(1024, result, 2);
    assert(memcmp(source, result, sizeof(result)) == 0);
    float second[4]; ring.read(1024, second, 2);
    assert(memcmp(second, result, sizeof(result)) == 0); // independent readers
    ring.read(1026, result, 2);
    for (float v : result) assert(v == 0); // no stale samples after the writer stops
    ring.clear(); ring.read(1024, result, 2);
    for (float v : result) assert(v == 0);
    ring.write(32768, source, 2); ring.read(1024, result, 2);
    for (float v : result) assert(v == 0); // wraparound cannot masquerade as old data
    ring.read(32768 + 1024, result, 2);
    assert(memcmp(source, result, sizeof(result)) == 0);

    // Concurrent readers may get silence during overwrite, never torn L/R data.
    std::atomic<bool> done{false};
    std::thread writer([&] {
        for (int64_t i = 0; i < 200000; ++i) { float stereo[2] = {float(i), -float(i)}; ring.write(i, stereo, 1); }
        done = true;
    });
    int64_t position = 0;
    while (!done) {
        float stereo[2]; ring.read(position++ % 200000 + 1024, stereo, 1);
        assert(stereo[0] == -stereo[1] || (stereo[0] == 0.25f && stereo[1] == -0.5f) || (stereo[0] == 0.75f && stereo[1] == -1.f));
    }
    writer.join();
    lumen::AudioFIFO fifo;
    assert(fifo.push(source, 2)); fifo.pop(result, 2);
    assert(memcmp(source, result, sizeof(result)) == 0);
    fifo.pop(result, 2); for (float v : result) assert(v == 0);
    std::vector<float> huge(32770); assert(!fifo.push(huge.data(), 16385));
    std::vector<float> backlog(12000);
    for (size_t i = 0; i < 6000; ++i) backlog[i * 2] = backlog[i * 2 + 1] = float(i);
    assert(fifo.push(backlog.data(), 6000)); fifo.pop(result, 2);
    assert(result[0] == 3952); // drops excessive latency, resumes near live
    std::cout << "Audio ring: stereo, multiple readers, silence, wraparound, concurrency and bounded latency passed\n";
}
