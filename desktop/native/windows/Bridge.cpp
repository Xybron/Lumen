#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <setupapi.h>
#include <newdev.h>
#include <devguid.h>
#include <wrl/client.h>
#include <io.h>
#include <fcntl.h>
#include <thread>
#include <atomic>
#include <mutex>
#include <vector>
#include <string>
#include <stdexcept>
#include <cstdio>
#include "../macos/AudioRing.hpp"

using Microsoft::WRL::ComPtr;
static std::mutex outputLock;
static constexpr size_t videoBytes = 1280 * 720 * 4;
static const wchar_t* cameraCLSID = L"{2D3ED953-ED42-481A-BC74-66F06DB3C707}";
static void report(const std::string& line) {
    std::lock_guard<std::mutex> lock(outputLock);
    std::printf("%s\n", line.c_str()); std::fflush(stdout);
}
static void check(HRESULT value, const char* action) {
    if (FAILED(value)) throw std::runtime_error(std::string(action) + " (HRESULT " + std::to_string(uint32_t(value)) + ")");
}
static std::wstring folder() {
    std::vector<wchar_t> value(32768);
    DWORD length = GetModuleFileNameW(nullptr, value.data(), DWORD(value.size()));
    if (!length || length >= value.size()) throw std::runtime_error("Cannot locate Lumen devices");
    std::wstring path(value.data(), length); return path.substr(0, path.find_last_of(L"\\"));
}
// Private INF endpoint marker survives renames and Windows' display-name suffixes.
static const PROPERTYKEY lumenEndpointRole = {{0xc70970f4, 0x8b46, 0x40dd, {0xae, 0x5e, 0x1c, 0x9a, 0xb6, 0x43, 0x69, 0xe7}}, 1};
static ComPtr<IMMDevice> endpoint(EDataFlow flow, const wchar_t* expected) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "Open audio devices");
    ComPtr<IMMDeviceCollection> collection;
    check(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection), "Read audio endpoints");
    UINT count = 0; check(collection->GetCount(&count), "Count audio endpoints");
    for (UINT i = 0; i < count; ++i) {
        ComPtr<IMMDevice> device; ComPtr<IPropertyStore> properties;
        if (FAILED(collection->Item(i, &device)) || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) continue;
        PROPVARIANT name; PropVariantInit(&name);
        HRESULT result = properties->GetValue(lumenEndpointRole, &name);
        bool match = SUCCEEDED(result) && name.vt == VT_LPWSTR && name.pwszVal && !wcscmp(name.pwszVal, expected);
        PropVariantClear(&name);
        if (match) return device;
    }
    return {};
}
static bool cameraInstalled() {
    std::wstring key = L"Software\\Classes\\CLSID\\" + std::wstring(cameraCLSID) + L"\\InprocServer32";
    HKEY value = nullptr;
    auto result = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.c_str(), 0, KEY_READ | KEY_WOW64_64KEY, &value);
    if (value) RegCloseKey(value);
    return result == ERROR_SUCCESS;
}

class ProgramOutput {
    using CreateCamera = void*(__cdecl*)(int, int, float);
    using DeleteCamera = void(__cdecl*)(void*);
    using SendFrame = void(__cdecl*)(void*, const void*);
    HMODULE library = nullptr;
    void* camera = nullptr;
    DeleteCamera deleteCamera = nullptr;
    SendFrame sendFrame = nullptr;
    ComPtr<IAudioClient> client;
    ComPtr<IAudioRenderClient> render;
    HANDLE event = nullptr;
    UINT32 capacity = 0;
    std::thread worker;
    std::atomic<bool> stopping{false};
    lumen::AudioFIFO fifo;
    std::vector<uint8_t> bgr = std::vector<uint8_t>(1280 * 720 * 3);
public:
    void start() {
        auto device = endpoint(eRender, L"program");
        if (!device || !endpoint(eCapture, L"microphone") || !cameraInstalled())
            throw std::runtime_error("Install both Lumen devices before starting");
        library = LoadLibraryExW((folder() + L"\\LumenCamera.dll").c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!library) throw std::runtime_error("Cannot load Lumen Camera");
        auto create = reinterpret_cast<CreateCamera>(GetProcAddress(library, "scCreateCamera"));
        deleteCamera = reinterpret_cast<DeleteCamera>(GetProcAddress(library, "scDeleteCamera"));
        sendFrame = reinterpret_cast<SendFrame>(GetProcAddress(library, "scSendFrame"));
        // The Program receiver already limits video to 30 fps. Do not sleep in
        // scSendFrame: audio packets share this pipe and must keep flowing.
        if (!create || !deleteCamera || !sendFrame || !(camera = create(1280, 720, 0)))
            throw std::runtime_error("Lumen Camera is already being sent by another process");
        check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client), "Open Lumen audio");
        WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 384000, 8, 32, 0};
        check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            0, 0, &format, nullptr), "Configure stereo Program audio");
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event) throw std::runtime_error("Cannot create audio event");
        check(client->SetEventHandle(event), "Set audio event");
        check(client->GetBufferSize(&capacity), "Read audio buffer size");
        check(client->GetService(IID_PPV_ARGS(&render)), "Open audio renderer");
        BYTE* data = nullptr;
        check(render->GetBuffer(capacity, &data), "Prime audio buffer");
        check(render->ReleaseBuffer(capacity, AUDCLNT_BUFFERFLAGS_SILENT), "Prime silence");
        check(client->Start(), "Start Lumen microphone feed");
        worker = std::thread([this] {
            CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            while (!stopping.load()) {
                if (WaitForSingleObject(event, 100) != WAIT_OBJECT_0) continue;
                UINT32 pending = 0;
                HRESULT result = client->GetCurrentPadding(&pending);
                if (FAILED(result) || pending > capacity) { report("{\"error\":\"Lumen audio device disconnected\"}"); break; }
                UINT32 frames = capacity - pending;
                if (!frames) continue;
                BYTE* bytes = nullptr;
                if (FAILED(render->GetBuffer(frames, &bytes))) { report("{\"error\":\"Lumen audio buffer failed\"}"); break; }
                fifo.pop(reinterpret_cast<float*>(bytes), frames);
                if (FAILED(render->ReleaseBuffer(frames, 0))) { report("{\"error\":\"Lumen audio delivery failed\"}"); break; }
            }
            CoUninitialize();
        });
    }
    bool video(const uint8_t* bytes) {
        for (size_t i = 0, j = 0; i < videoBytes; i += 4, j += 3) {
            bgr[j] = bytes[i]; bgr[j + 1] = bytes[i + 1]; bgr[j + 2] = bytes[i + 2];
        }
        sendFrame(camera, bgr.data()); return true;
    }
    bool sound(const uint8_t* bytes, size_t size) { return fifo.push(reinterpret_cast<const float*>(bytes), size / 8); }
    ~ProgramOutput() {
        stopping = true; if (event) SetEvent(event);
        if (worker.joinable()) worker.join();
        if (client) client->Stop();
        if (event) CloseHandle(event);
        if (camera && deleteCamera) deleteCamera(camera);
        if (library) FreeLibrary(library);
    }
};

static bool matchingDevice(HDEVINFO devices, SP_DEVINFO_DATA& device) {
    wchar_t ids[4096]{};
    if (!SetupDiGetDeviceRegistryPropertyW(devices, &device, SPDRP_HARDWAREID, nullptr,
        reinterpret_cast<BYTE*>(ids), sizeof(ids), nullptr)) return false;
    for (const wchar_t* id = ids; *id; id += wcslen(id) + 1) if (!_wcsicmp(id, L"ROOT\\LumenAudio")) return true;
    return false;
}
static int installAudio(const wchar_t* inf, bool remove) {
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_MEDIA, nullptr, nullptr, DIGCF_PRESENT);
    if (devices == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot enumerate audio adapters");
    SP_DEVINFO_DATA device{sizeof(device)};
    bool exists = false;
    for (DWORD i = 0; SetupDiEnumDeviceInfo(devices, i, &device); ++i) {
        if (!matchingDevice(devices, device)) continue;
        exists = true;
        if (remove && !SetupDiCallClassInstaller(DIF_REMOVE, devices, &device)) {
            SetupDiDestroyDeviceInfoList(devices); throw std::runtime_error("Cannot remove Lumen audio adapter");
        }
        break;
    }
    SetupDiDestroyDeviceInfoList(devices);
    if (remove) {
        BOOL reboot = FALSE;
        if (!DiUninstallDriverW(nullptr, inf, 0, &reboot) && exists && GetLastError() != ERROR_FILE_NOT_FOUND)
            throw std::runtime_error("Cannot remove the Lumen driver package");
        return reboot ? 3010 : 0;
    }
    HDEVINFO created = INVALID_HANDLE_VALUE;
    SP_DEVINFO_DATA newDevice{sizeof(newDevice)};
    if (!exists) {
        created = SetupDiCreateDeviceInfoList(&GUID_DEVCLASS_MEDIA, nullptr);
        const wchar_t id[] = L"ROOT\\LumenAudio\0";
        if (created == INVALID_HANDLE_VALUE ||
            !SetupDiCreateDeviceInfoW(created, L"MEDIA", &GUID_DEVCLASS_MEDIA, L"Lumen Audio", nullptr, DICD_GENERATE_ID, &newDevice) ||
            !SetupDiSetDeviceRegistryPropertyW(created, &newDevice, SPDRP_HARDWAREID, reinterpret_cast<const BYTE*>(id), sizeof(id)) ||
            !SetupDiCallClassInstaller(DIF_REGISTERDEVICE, created, &newDevice)) {
            if (created != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(created);
            throw std::runtime_error("Cannot create Lumen audio adapter");
        }
    }
    BOOL reboot = FALSE;
    bool success = UpdateDriverForPlugAndPlayDevicesW(nullptr, L"ROOT\\LumenAudio", inf, INSTALLFLAG_FORCE, &reboot);
    auto error = GetLastError();
    if (created != INVALID_HANDLE_VALUE) {
        if (!success) SetupDiCallClassInstaller(DIF_REMOVE, created, &newDevice);
        SetupDiDestroyDeviceInfoList(created);
    }
    if (!success) throw std::runtime_error("Windows rejected the Lumen audio driver (" + std::to_string(error) + ")");
    return reboot ? 3010 : 0;
}
static bool readExact(void* destination, size_t size) { return std::fread(destination, 1, size, stdin) == size; }
int wmain(int argc, wchar_t** argv) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    _setmode(_fileno(stdin), _O_BINARY);
    try {
        if (argc == 3 && (!wcscmp(argv[1], L"install-audio") || !wcscmp(argv[1], L"remove-audio")))
            return installAudio(argv[2], !wcscmp(argv[1], L"remove-audio"));
        if (argc != 2) throw std::runtime_error("Invalid Lumen device command");
        if (!wcscmp(argv[1], L"status")) {
            bool microphone = !!endpoint(eCapture, L"microphone") && !!endpoint(eRender, L"program");
            report(std::string("{\"camera\":") + (cameraInstalled() ? "true" : "false") + ",\"microphone\":" + (microphone ? "true}" : "false}"));
            return 0;
        }
        if (wcscmp(argv[1], L"stream")) throw std::runtime_error("Unknown Lumen device command");
        ProgramOutput output; output.start(); report("{\"state\":\"ready\"}");
        uint32_t header[3]; std::vector<uint8_t> payload(videoBytes);
        while (readExact(header, sizeof(header))) {
            uint32_t type = header[1], size = header[2];
            if (header[0] != 0x314d554c || !((type == 1 && size == videoBytes) || (type == 2 && size && size <= 32768 && size % 8 == 0)))
                throw std::runtime_error("Invalid media packet");
            if (!readExact(payload.data(), size)) throw std::runtime_error("Incomplete media packet");
            bool accepted = type == 1 ? output.video(payload.data()) : output.sound(payload.data(), size);
            report(std::string("{\"ack\":") + std::to_string(type) + ",\"accepted\":" + (accepted ? "true}" : "false}"));
        }
    } catch (const std::exception& error) {
        // Messages above contain no arbitrary paths or user text; escape anyway.
        std::string escaped;
        for (char c : std::string(error.what())) { if (c == '"' || c == '\\') escaped += '\\'; if (c >= ' ') escaped += c; }
        report("{\"error\":\"" + escaped + "\"}"); return 1;
    }
    return 0;
}
