#include "../Loopback.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
int main() {
    lumen::Loopback ring{};
    uint64_t first = lumen::Loopback::noReader, second = first;
    unsigned char input[] = {0, 64, 0, 128, 255, 127, 0, 0}, output[16];
    ring.read(output, 2, first, 1);
    for (auto b : output) assert(b == 0);
    ring.write(input, 2, 100);
    ring.read(output, 2, first, 101);
    int32_t samples[4]; std::memcpy(samples, output, sizeof(samples));
    assert(samples[0] == 1073741824 && samples[1] == INT32_MIN && samples[2] == 2147418112 && samples[3] == 0);
    unsigned char other[16]; ring.read(other, 2, second, 101);
    assert(!memcmp(output, other, sizeof(output)));
    ring.read(output, 2, first, 102);
    for (auto b : output) assert(b == 0);
    ring.write(input, 2, 200); ring.read(output, 2, first, 2000000);
    for (auto b : output) assert(b == 0);
    // Restart and wrap cannot expose an expired buffer; lagging readers catch up.
    for (int i = 0; i < 20000; ++i) ring.write(input, 2, 2000001 + i);
    ring.read(output, 2, first, 2020002);
    assert(first >= ring.written - lumen::Loopback::delay);
    std::cout << "Windows loopback: PCM conversion, independent readers, silence, expiry and bounded latency passed\n";
}
