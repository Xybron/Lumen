Derived from Microsoft Windows-driver-samples, audio/simpleaudiosample,
commit d49bb7d72f3651952b2b6e4ad28d14fe2247eb69.
https://github.com/microsoft/Windows-driver-samples

MIT license retained in LICENSE. Source comments retain Microsoft's attribution.

Lumen changes: product/service/hardware identifiers and endpoint names; minimum
Windows 10 build 19041 (the sample uses ExAllocatePool2); real render-to-capture
loopback in minwavertstream; no tone generation or recording of rendered audio;
default microphone processing mode in addition to raw. Loopback.hpp is Lumen's
bounded, separately tested PCM transport. It runs under a kernel spinlock and
uses independent capture cursors, with silence when the producer disappears.

Removed the sample's advertised but nonfunctional hardware volume/mute nodes;
Windows supplies software endpoint controls in shared mode. Added private
endpoint identity markers and disabled default-device selection. The build
pins KMDF 1.31 for Windows 10 2004 compatibility.
