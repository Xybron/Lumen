#include "softcamcore/FrameBuffer.h"
#include <cassert>
#include <algorithm>
#include <vector>
#include <iostream>

int main() {
    using softcam::FrameBuffer;
    assert(!FrameBuffer::create(640, 480, 30));
    auto sender = FrameBuffer::create(1280, 720, 30);
    assert(sender && !FrameBuffer::create(1280, 720, 30));
    auto first = FrameBuffer::open(), second = FrameBuffer::open();
    assert(first && second && first.width() == 1280 && first.height() == 720);
    std::vector<unsigned char> source(1280 * 720 * 3, 0), image(source.size(), 255);
    uint64_t count = 0;
    first.transferToDIB(image.data(), &count);
    assert(std::all_of(image.begin(), image.end(), [](auto b) { return b == 0; }));
    // Input is top-down BGR; DirectShow's positive-height DIB is bottom-up.
    source[0] = 17; source[1] = 41; source[2] = 93;
    sender.write(source.data());
    for (auto receiver : {&first, &second}) {
        receiver->transferToDIB(image.data(), &count);
        const size_t bottom = 1280 * 719 * 3;
        assert(count == 1 && image[bottom] == 17 && image[bottom + 1] == 41 && image[bottom + 2] == 93);
    }
    softcam::Timer::sleep(0.6f);
    first.transferToDIB(image.data(), &count);
    assert(std::all_of(image.begin(), image.end(), [](auto b) { return b == 0; }));
    sender.write(source.data()); sender.deactivate();
    second.transferToDIB(image.data(), &count);
    assert(std::all_of(image.begin(), image.end(), [](auto b) { return b == 0; }));
    first.release(); second.release(); sender.release();
    auto restarted = FrameBuffer::create(1280, 720, 30);
    assert(restarted);
    std::cout << "Camera shared memory: format, multiple readers, pixel orientation, expiry and restart passed\n";
}
