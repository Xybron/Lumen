import Foundation
import CoreMediaIO
import IOKit.audio
import Security

private let width: Int32 = 1280
private let height: Int32 = 720
private let frameDuration = CMTime(value: 1, timescale: 30)

final class LumenStream: NSObject, CMIOExtensionStreamSource {
    var stream: CMIOExtensionStream!
    let formats: [CMIOExtensionStreamFormat]
    var activeFormatIndex: Int = 0
    unowned let owner: LumenCamera
    let sink: Bool
    init(owner: LumenCamera, sink: Bool, format: CMFormatDescription) {
        self.owner = owner
        self.sink = sink
        formats = [CMIOExtensionStreamFormat(formatDescription: format,
            maxFrameDuration: frameDuration, minFrameDuration: frameDuration, validFrameDurations: nil)]
        super.init()
        stream = CMIOExtensionStream(localizedName: sink ? "Lumen Program Input" : "Lumen Camera",
            streamID: UUID(uuidString: sink ? "0AD8C8C2-C85C-4DCF-AFA9-70415819E242" : "0AD8C8C2-C85C-4DCF-AFA9-70415819E241")!,
            direction: sink ? .sink : .source, clockType: .hostTime, source: self)
    }
    var availableProperties: Set<CMIOExtensionProperty> {
        var properties: Set<CMIOExtensionProperty> = [.streamActiveFormatIndex, .streamFrameDuration]
        if sink { properties.formUnion([.streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup]) }
        return properties
    }
    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let result = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { result.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { result.frameDuration = frameDuration }
        if sink {
            result.sinkBufferQueueSize = 3
            result.sinkBuffersRequiredForStartup = 1
        }
        return result
    }
    func setStreamProperties(_ properties: CMIOExtensionStreamProperties) throws {
        // This version publishes one fixed format; host-side scaling is explicit.
        activeFormatIndex = 0
    }
    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        if !sink { return true }
        // CMIO handles reader privacy. Only our signed bridge may replace Program.
        guard client.signingID == "app.lumen.studio.device-bridge",
              let team = Bundle.main.object(forInfoDictionaryKey: "LumenTeamIdentifier") as? String,
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return false }
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: client.pid] as CFDictionary,
            [], &code) == errSecSuccess, let code else { return false }
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"app.lumen.studio.device-bridge\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
        return owner.accept(client)
    }
    func startStream() throws { owner.start(sink: sink) }
    func stopStream() throws { owner.stop(sink: sink) }
}

final class LumenCamera: NSObject, CMIOExtensionDeviceSource {
    var device: CMIOExtensionDevice!
    var output: LumenStream!
    var input: LumenStream!
    private var format: CMFormatDescription!
    private var pool: CVPixelBufferPool!
    private let queue = DispatchQueue(label: "app.lumen.studio.camera.frames", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private var readers = 0
    private var client: CMIOExtensionClient?
    private var feeding = false
    private var consuming = false
    private var generation: UInt64 = 0
    private var latest: CVPixelBuffer?
    private var lastFrameAt = CMTime.zero

    override init() {
        super.init()
        device = CMIOExtensionDevice(localizedName: "Lumen Camera",
            deviceID: UUID(uuidString: "0AD8C8C2-C85C-4DCF-AFA9-70415819E240")!, legacyDeviceID: nil, source: self)
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
            width: width, height: height, extensions: nil, formatDescriptionOut: &format)
        let attributes: [String: Any] = [kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height, kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
        guard format != nil, pool != nil else { fatalError("Lumen camera buffer allocation failed") }
        output = LumenStream(owner: self, sink: false, format: format)
        input = LumenStream(owner: self, sink: true, format: format)
        do { try device.addStream(output.stream); try device.addStream(input.stream) }
        catch { fatalError("Lumen camera stream registration failed: \(error)") }
    }
    var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }
    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let result = CMIOExtensionDeviceProperties(dictionary: [:])
        result.transportType = kIOAudioDeviceTransportTypeVirtual
        result.model = "Lumen Program Camera"
        return result
    }
    func setDeviceProperties(_ properties: CMIOExtensionDeviceProperties) throws {}
    func accept(_ candidate: CMIOExtensionClient) -> Bool {
        queue.sync {
            if let client, client.clientID != candidate.clientID { return false }
            client = candidate
            return true
        }
    }
    func disconnected(_ candidate: CMIOExtensionClient) {
        queue.async {
            if self.client?.clientID == candidate.clientID { self.stopFeeding() }
        }
    }
    private func stopFeeding() {
        feeding = false; consuming = false; generation &+= 1
        client = nil; latest = nil
        if readers == 0 { timer?.cancel(); timer = nil }
    }
    func start(sink: Bool) {
        queue.async {
            if sink { self.feeding = true } else { self.readers += 1 }
            guard self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / 30), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
        }
    }
    func stop(sink: Bool) {
        queue.async {
            if sink { self.stopFeeding() } else { self.readers = max(0, self.readers - 1) }
            if !self.feeding && self.readers == 0 { self.timer?.cancel(); self.timer = nil; self.latest = nil }
        }
    }
    private func consume() {
        guard feeding, !consuming, let client else { return }
        consuming = true
        let currentGeneration = generation
        input.stream.consumeSampleBuffer(from: client) { [weak self] sample, sequence, _, more, _ in
            guard let self else { return }
            self.queue.async {
                guard currentGeneration == self.generation else { return }
                self.consuming = false
                if let sample, let pixel = CMSampleBufferGetImageBuffer(sample),
                   CVPixelBufferGetWidth(pixel) == width, CVPixelBufferGetHeight(pixel) == height,
                   CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA {
                    self.latest = pixel
                    self.lastFrameAt = CMClockGetTime(CMClockGetHostTimeClock())
                    self.input.stream.notifyScheduledOutputChanged(CMIOExtensionScheduledOutput(sequenceNumber: sequence,
                        hostTimeInNanoseconds: UInt64(self.lastFrameAt.seconds * 1_000_000_000)))
                }
                if more { self.consume() }
            }
        }
    }
    private func tick() {
        consume()
        guard readers > 0 else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        var pixel = latest
        // Stop, engine loss and a crashed producer must never leave a private last frame visible.
        if !feeding || now.seconds - lastFrameAt.seconds > 0.5 {
            pixel = nil
            guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixel) == kCVReturnSuccess,
                  let black = pixel else { return }
            CVPixelBufferLockBaseAddress(black, [])
            if let base = CVPixelBufferGetBaseAddress(black) {
                memset(base, 0, CVPixelBufferGetBytesPerRow(black) * Int(height))
            }
            CVPixelBufferUnlockBaseAddress(black, [])
        }
        guard let pixel else { return }
        var timing = CMSampleTimingInfo(duration: frameDuration, presentationTimeStamp: now, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixel,
            dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
            sampleTiming: &timing, sampleBufferOut: &sample)
        if let sample { output.stream.send(sample, discontinuity: [], hostTimeInNanoseconds: UInt64(now.seconds * 1_000_000_000)) }
    }
}

final class LumenProvider: NSObject, CMIOExtensionProviderSource {
    var provider: CMIOExtensionProvider!
    let camera = LumenCamera()
    override init() {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: nil)
        do { try provider.addDevice(camera.device) } catch { fatalError("Lumen camera registration failed: \(error)") }
    }
    var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }
    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let result = CMIOExtensionProviderProperties(dictionary: [:]); result.manufacturer = "Lumen"; return result
    }
    func setProviderProperties(_ properties: CMIOExtensionProviderProperties) throws {}
    func connect(to client: CMIOExtensionClient) throws {}
    func disconnect(from client: CMIOExtensionClient) { camera.disconnected(client) }
}
