// OfficeSim's system audio capture.
//
// Listens to what the Mac is playing (Spotify, a video, anything) so the office's DJ booth can
// react to it. macOS doesn't let a web page hear the system, so this does it natively with a Core
// Audio process tap: a tap on the system's audio output, wrapped in an aggregate device we can
// read samples from.
//
// The tap needs the "System Audio Recording" permission. macOS asks for it the first time the
// device starts, and opens System Settings if the request is declined.
//
// It never records, saves or sends audio anywhere: each block of samples is turned into a few
// numbers (how loud the bass is, how loud each band is, whether a beat just landed) and thrown
// away.
//
// Usage: officesim-audio [--print-permission]
//   With no arguments it captures, writing one JSON line per tick to stdout:
//     {"playing":true,"beat":0.0,"bands":[0.1,0.2,...]}
//   With --print-permission it says whether the capture is allowed, and exits.

import AVFoundation
import CoreAudio
import Foundation

// ── Tuning ──────────────────────────────────────────────────────

/// How often a line is written.
let tickInterval = 0.05
/// A beat is bass this much louder than its recent average.
let beatRatio: Float = 1.3
/// Beats at least this far apart.
let minBeatGap: Double = 0.24
/// Average level below which it's treated as silence.
let silenceLevel: Float = 6
/// How long the music keeps playing through a quiet bar.
let silenceHold: Double = 1.5
/// Bands of loudness for the level meter, low to high.
let meterBands = 6

// ── The capture ─────────────────────────────────────────────────

/// Says something about the capture on the error output, so the app can explain it.
func note(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

/// A private tap on the system's audio output, in an aggregate device we can read from.
final class SystemAudioCapture {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let lock = NSLock()
    /// The samples from the last tick, waiting to be read.
    private var pending: [Float] = []
    /// The tap's own format: the rate and channels the samples come in at.
    private var format = AudioStreamBasicDescription()

    /// Starts capturing. Returns nil and a reason when macOS won't allow it.
    func start() -> String? {
        let description = makeTap()

        let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
        guard tapStatus == noErr else {
            return "macOS wouldn't let OfficeSim make an audio tap."
        }

        // The aggregate device holds the tap as a sub-tap. The tap's own format is used, so
        // there's nothing to set: the device is created with the tap's format.
        // The values are numbers, not booleans: Core Audio wants them as such.
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "OfficeSim System Audio",
            kAudioAggregateDeviceUIDKey as String: "com.officesim.mac.system-audio.\(UUID().uuidString)",
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey as String: NSNumber(value: true)
                ]
            ],
            kAudioAggregateDeviceTapAutoStartKey as String: NSNumber(value: true),
            kAudioAggregateDeviceIsPrivateKey as String: NSNumber(value: true),
        ]
        let created = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &deviceID)
        guard created == noErr else {
            return "macOS wouldn't let OfficeSim make an audio device for the tap."
        }

        // The tap's own format: the samples come in at this rate, in this many channels.
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let formatStatus = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &format)
        guard formatStatus == noErr, format.mSampleRate > 0 else {
            return "macOS wouldn't say what format the tapped audio is in."
        }

        // The callback is a C function pointer, so it can't capture: the capture is passed through
        // the client info pointer instead.
        let callback: AudioDeviceIOProc = { _, _, inputData, _, _, _, clientInfo in
            guard let clientInfo else { return noErr }
            let capture = Unmanaged<SystemAudioCapture>.fromOpaque(clientInfo).takeUnretainedValue()
            let buffers = inputData.pointee.mBuffers
            guard let data = buffers.mData else { return noErr }
            let count = Int(buffers.mDataByteSize) / MemoryLayout<Float>.size
            guard count > 0 else { return noErr }
            let source = data.assumingMemoryBound(to: Float.self)
            let samples = Array(UnsafeBufferPointer(start: source, count: count))
            capture.lock.lock()
            capture.pending.append(contentsOf: samples)
            capture.lock.unlock()
            return noErr
        }
        let clientInfo = Unmanaged.passUnretained(self).toOpaque()
        let procStatus = AudioDeviceCreateIOProcID(deviceID, callback, clientInfo, &ioProcID)
        guard procStatus == noErr else {
            return "macOS wouldn't let OfficeSim listen to the audio device."
        }
        let startStatus = AudioDeviceStart(deviceID, ioProcID)
        guard startStatus == noErr else {
            // This is the permission gate: macOS asks for System Audio Recording here.
            return "macOS hasn't allowed OfficeSim to record the system audio yet."
        }
        return nil
    }

    /// The samples captured since the last call: the channels mixed down to one.
    func takeSamples() -> [Float] {
        lock.lock()
        defer { lock.unlock() }
        let raw = pending
        pending.removeAll(keepingCapacity: true)
        let channels = max(1, Int(format.mChannelsPerFrame))
        guard channels > 1 else { return raw }
        // The tap gives the channels one after another, so they're averaged into one
        var mixed = [Float](repeating: 0, count: raw.count / channels)
        for index in 0..<mixed.count {
            var sum: Float = 0
            for channel in 0..<channels {
                sum += raw[index * channels + channel]
            }
            mixed[index] = sum / Float(channels)
        }
        return mixed
    }

    /// The rate the samples come in at.
    var sampleRate: Double { format.mSampleRate }

    /// Stops the capture.
    ///
    /// The device is destroyed rather than stopped: stopping waits for the audio to finish, which
    /// can take a minute and a half when nothing is playing.
    func stop() {
        if let ioProcID {
            AudioDeviceDestroyIOProcID(deviceID, ioProcID)
            self.ioProcID = nil
        }
        if deviceID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(deviceID)
            deviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

// ── The analysis ────────────────────────────────────────────────

/// What the office needs to know about the music right now.
struct Levels {
    var playing = false
    var beat: Float = 0
    var bands: [Float] = []
}

/// Turns the captured samples into levels, the way the office's music listener does in a browser.
final class Analyser {
    private var bassAverage: Float = 0
    private var lastBeat = Date.distantPast
    private var lastSound = Date.distantPast
    private var beat: Float = 0

    /// The levels of a block of samples.
    func analyse(_ samples: [Float], now: Date) -> Levels {
        var levels = Levels()
        guard !samples.isEmpty else {
            levels.beat = beat
            return levels
        }

        // An FFT over the block: how much of it is in each frequency band.
        let bins = FFT(size: samples.count).forward(samples)
        guard !bins.isEmpty else {
            levels.beat = beat
            return levels
        }

        // The bass, in the bins the browser uses (1 to 5), which at 48kHz over 2048 samples are
        // roughly 23Hz to 117Hz.
        var bass: Float = 0
        var bassCount: Float = 0
        for bin in 1...5 where bin < bins.count {
            bass += bins[bin]
            bassCount += 1
        }
        if bassCount > 0 { bass /= bassCount }

        var total: Float = 0
        for value in bins { total += value }
        let level = total / Float(bins.count)
        if level > silenceLevel { lastSound = now }

        // The beat eases away, and lands when the bass jumps above its recent average.
        beat *= 0.88
        if bass > bassAverage * beatRatio && bass > 60,
            now.timeIntervalSince(lastBeat) > minBeatGap {
            beat = 1
            lastBeat = now
        }
        bassAverage = bassAverage * 0.94 + bass * 0.06

        // Bands from the bass up, for the level meter. The edges are the same bins the browser's
        // analyser uses: powers of two, 1.3 apart.
        var meter: [Float] = []
        for band in 0..<meterBands {
            let from = max(1, Int(pow(2.0, Double(band) * 1.3)))
            let to = min(bins.count, Int(pow(2.0, Double(band + 1) * 1.3)) + 1)
            var sum: Float = 0
            for index in from..<max(from + 1, to) where index < bins.count { sum += bins[index] }
            meter.append(sum / Float(max(1, to - from)) / 255)
        }

        levels.playing = now.timeIntervalSince(lastSound) < silenceHold
        levels.beat = beat
        levels.bands = meter
        return levels
    }
}

/// A radix-2 FFT, so the levels match the browser analyser the office already uses.
///
/// The browser's AnalyserNode turns each bin into a byte: the magnitude in decibels, mapped from
/// -100dB to -30dB onto 0..255. This does the same, so the office's thresholds (a silent room, a
/// beat) mean the same thing in both.
final class FFT {
    /// The browser's default range for the byte values.
    private static let minDecibels: Float = -100
    private static let maxDecibels: Float = -30

    private let size: Int
    private let log2n: Int
    private let cosTable: [Float]
    private let sinTable: [Float]
    private let reverse: [Int]

    init(size: Int) {
        self.size = size
        log2n = Int(log2(Double(size)).rounded())
        var cosines = [Float](repeating: 0, count: size / 2)
        var sines = [Float](repeating: 0, count: size / 2)
        for index in 0..<(size / 2) {
            let angle = 2 * Float.pi * Float(index) / Float(size)
            cosines[index] = cos(angle)
            sines[index] = sin(angle)
        }
        cosTable = cosines
        sinTable = sines
        var reversed = [Int](repeating: 0, count: size)
        for index in 0..<size {
            var value = index
            var reversedBits = 0
            for _ in 0..<log2n {
                reversedBits = (reversedBits << 1) | (value & 1)
                value >>= 1
            }
            reversed[index] = reversedBits
        }
        reverse = reversed
    }

    /// The loudness of each frequency bin, as the browser's analyser gives it: 0..255.
    func forward(_ input: [Float]) -> [Float] {
        guard input.count >= size else { return [] }
        var real = [Float](repeating: 0, count: size)
        var imaginary = [Float](repeating: 0, count: size)
        for index in 0..<size {
            real[index] = input[reverse[index]]
        }
        var realSize = size
        while realSize > 1 {
            let halfSize = realSize / 2
            let step = size / realSize
            for offset in stride(from: 0, to: realSize, by: realSize) {
                var tableIndex = 0
                for index in 0..<halfSize {
                    let upper = offset + index
                    let lower = upper + halfSize
                    let cosValue = cosTable[tableIndex]
                    let sinValue = sinTable[tableIndex]
                    let productReal = real[lower] * cosValue + imaginary[lower] * sinValue
                    let productImaginary = real[lower] * sinValue - imaginary[lower] * cosValue
                    real[lower] = real[upper] - productReal
                    imaginary[lower] = imaginary[upper] - productImaginary
                    real[upper] += productReal
                    imaginary[upper] += productImaginary
                    tableIndex += step
                }
            }
            realSize = halfSize
        }
        var magnitudes = [Float](repeating: 0, count: size / 2)
        for index in 0..<(size / 2) {
            // The browser's magnitude: the sum of the two halves, over the size of the transform
            let magnitude = (real[index] * real[index] + imaginary[index] * imaginary[index]).squareRoot()
            magnitudes[index] = Self.decibels(magnitude: magnitude / Float(size) * 2)
        }
        return magnitudes
    }

    /// A magnitude as the browser's byte value: decibels, mapped from -100dB to -30dB onto 0..255.
    static func decibels(magnitude: Float) -> Float {
        guard magnitude > 0 else { return 0 }
        let db = 20 * log10(magnitude)
        let clamped = min(max(db, minDecibels), maxDecibels)
        return (clamped - minDecibels) / (maxDecibels - minDecibels) * 255
    }
}

// ── Running it ──────────────────────────────────────────────────

/// A tap over everything the Mac is playing.
///
/// The list is what to leave out, so it's empty: everything is tapped.
func makeTap() -> CATapDescription {
    let description = CATapDescription(__stereoGlobalTapButExcludeProcesses: [])
    description.name = "OfficeSim"
    description.uuid = UUID()
    // Private, so other apps don't see the tap.
    description.isPrivate = true
    description.muteBehavior = .unmuted
    description.isMixdown = true
    return description
}

/// Whether the capture is allowed right now.
///
/// The tap's own format can only be read once macOS has allowed the capture, so this is the
/// permission check: it starts the tap and reads its format, without starting the audio device
/// (which would wait for sound that isn't playing).
func permissionState() -> String {
    let description = makeTap()
    var tapID = AudioObjectID(kAudioObjectUnknown)
    guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else {
        return "denied"
    }
    defer { AudioHardwareDestroyProcessTap(tapID) }
    // Reading the format asks macOS for the permission, and fails without it.
    var formatAddress = AudioObjectPropertyAddress(
        mSelector: kAudioTapPropertyFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var format = AudioStreamBasicDescription()
    var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &format)
    return status == noErr && format.mSampleRate > 0 ? "allowed" : "denied"
}

let arguments = CommandLine.arguments
if arguments.contains("--print-permission") {
    print(permissionState())
    // The audio thread keeps the process alive after the capture stops, so the process is ended
    // here rather than left to finish on its own.
    exit(0)
}

let capture = SystemAudioCapture()
if let problem = capture.start() {
    note("can't capture: \(problem)")
    FileHandle.standardError.write((problem + "\n").data(using: .utf8)!)
    exit(1)
}

// The tap's own rate, and a block of samples to analyse: a power of two, so the FFT works.
let rate = capture.sampleRate
let blockSize = 2048
note("analysing at \(rate)Hz")

let analyser = Analyser()
var carry: [Float] = []
var nextTick = Date()

// Keep the output unbuffered, so the app sees each line as it comes.
setvbuf(stdout, nil, _IONBF, 0)

while true {
    let now = Date()
    let samples = capture.takeSamples()
    carry.append(contentsOf: samples)
    if carry.count >= blockSize {
        let block = Array(carry.prefix(blockSize))
        carry.removeFirst(blockSize)
        let levels = analyser.analyse(block, now: now)
        let bands = levels.bands.map { String(format: "%.3f", $0) }.joined(separator: ",")
        print(String(format: "{\"playing\":%@,\"beat\":%.3f,\"bands\":[%@]}",
                     levels.playing ? "true" : "false", levels.beat, bands))
        nextTick = now.addingTimeInterval(tickInterval)
    }
    // Sleep until the next tick, or until samples arrive.
    let wait = max(0.005, nextTick.timeIntervalSince(now))
    Thread.sleep(forTimeInterval: min(wait, 0.02))
}
