Derived from tshino/softcam at commit d1acde4617782f87a3929d7a7528fa3e524ec56b.
https://github.com/tshino/softcam

MIT license retained in LICENSE; included Microsoft DirectShow Base Classes
also retain their upstream notices. Only src/ is used; Lumen supplies CMake.

Lumen changes: unique CLSID and local IPC names; fixed 720p/30 format available
before the producer starts; fresh-frame timestamps; black instead of an old
image on timeout/disconnect; bounded frame wait; fixed validated memory layout
for image copies. The source remains a DirectShow camera for Windows 10/11
desktop clients including Zoom and OBS, not a Windows 11-only MF camera.
