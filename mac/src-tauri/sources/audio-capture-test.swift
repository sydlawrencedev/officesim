// A test of the levels the capture computes, run with `swift audio-capture-test.swift`.
// It feeds the analyser known signals and checks what comes out: silence stays silent, a bass
// note is a beat, and a loud passage moves the meters.

import Foundation

// ── The pieces under test, copied from audio-capture.swift ──────

let beatRatio: Float = 1.3
let minBeatGap: Double = 0.24
let silenceLevel: Float = 6
let silenceHold: Double = 1.5
let meterBands = 6

struct Levels {
    var playing = false
    var beat: Float = 0
    var bands: [Float] = []
}

final class Analyser {
    private var bassAverage: Float = 0
    private var lastBeat = Date.distantPast
    private var lastSound = Date.distantPast
    private var beat: Float = 0

    func analyse(_ samples: [Float], now: Date) -> Levels {
        var levels = Levels()
        guard !samples.isEmpty else {
            levels.beat = beat
            return levels
        }
        let bins = FFT(size: samples.count).forward(samples)
        guard !bins.isEmpty else {
            levels.beat = beat
            return levels
        }
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
        beat *= 0.88
        if bass > bassAverage * beatRatio && bass > 60,
            now.timeIntervalSince(lastBeat) > minBeatGap {
            beat = 1
            lastBeat = now
        }
        bassAverage = bassAverage * 0.94 + bass * 0.06
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

    /// The bins covering a range of frequencies.
    private static func bins(from: Double, to: Double, rate: Double, count: Int) -> [Int] {
        let first = bin(for: from, rate: rate, count: count)
        let last = bin(for: to, rate: rate, count: count)
        return Array(first..<max(first + 1, last))
    }

    /// The bin a frequency falls in.
    private static func bin(for hz: Double, rate: Double, count: Int) -> Int {
        let bin = Int(hz / (rate / Double(count * 2)))
        return min(max(1, bin), max(1, count - 1))
    }
}

final class FFT {
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

    func forward(_ input: [Float]) -> [Float] {
        guard input.count >= size else { return [] }
        var real = [Float](repeating: 0, count: size)
        var imaginary = [Float](repeating: 0, count: size)
        for index in 0..<size { real[index] = input[reverse[index]] }
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
            let magnitude = (real[index] * real[index] + imaginary[index] * imaginary[index]).squareRoot()
            magnitudes[index] = FFT.decibels(magnitude: magnitude / Float(size) * 2)
        }
        return magnitudes
    }

    /// A magnitude as the browser's byte value: decibels, mapped from -100dB to -30dB onto 0..255.
    static func decibels(magnitude: Float) -> Float {
        guard magnitude > 0 else { return 0 }
        let db = 20 * log10(magnitude)
        let clamped = min(max(db, -100), -30)
        return (clamped - (-100)) / ((-30) - (-100)) * 255
    }
}

// ── The test ────────────────────────────────────────────────────

var failures = 0
func check(_ what: String, _ ok: Bool, _ detail: String = "") {
    if ok {
        print("  ok    \(what)")
    } else {
        failures += 1
        print("  FAIL  \(what) \(detail)")
    }
}

/// A sine wave at a frequency, at an amplitude.
func tone(_ hz: Double, _ amplitude: Float, samples: Int = 2048, rate: Double = 48_000) -> [Float] {
    (0..<samples).map { index in
        amplitude * sin(2 * Float.pi * Float(hz) * Float(index) / Float(rate))
    }
}

/// Silence.
let quiet = [Float](repeating: 0, count: 2048)

print("levels")
let analyser = Analyser()
let start = Date()

// Silence is silence
let silence = analyser.analyse(quiet, now: start)
check("silence isn't playing", !silence.playing)
check("silence has no beat", silence.beat < 0.01)

// A loud low note is playing, and moves the low bands more than the high ones
let bassTone = analyser.analyse(tone(60, 0.5), now: start.addingTimeInterval(0.1))
check("a loud note is playing", bassTone.playing, "\(bassTone)")
check("the bass band moves", (bassTone.bands.first ?? 0) > 0.05, "\(bassTone.bands)")

// A high note moves the top band more than the bass would
// (the top band covers roughly 2-5kHz, so a 3kHz tone belongs there)
let quietHigh = Analyser().analyse(tone(3000, 0.002), now: start)
check("a high note moves the top band",
      (quietHigh.bands.last ?? 0) > (quietHigh.bands.first ?? 0),
      "bands: \(quietHigh.bands)")
let quietBass = Analyser().analyse(tone(60, 0.002), now: start)
check("a low note moves the bass band more than a high one",
      (quietBass.bands.first ?? 0) > (quietHigh.bands.first ?? 0),
      "bass: \(quietBass.bands), high: \(quietHigh.bands)")

// A beat: the bass jumps above its recent average
let beatAnalyser = Analyser()
_ = beatAnalyser.analyse(tone(60, 0.05), now: start)  // quiet, to set the average low
let beat = beatAnalyser.analyse(tone(60, 0.9), now: start.addingTimeInterval(0.3))
check("a bass jump is a beat", beat.beat > 0.5, "beat: \(beat.beat)")

// The next tick is the same loud tone, so no new beat: the old one eases away instead
let sameAgain = beatAnalyser.analyse(tone(60, 0.9), now: start.addingTimeInterval(0.4))
check("the same level again isn't a new beat", sameAgain.beat < 0.95, "beat: \(sameAgain.beat)")

// With no sound at all, the beat eases away to nothing
let fading = beatAnalyser.analyse(quiet, now: start.addingTimeInterval(0.9))
check("the beat eases away", fading.beat < 0.9 && fading.beat > 0, "beat: \(fading.beat)")
// It decays a little each tick, and the real loop calls analyse many times a second, so it
// dies away over a couple of seconds
var beatNow = fading.beat
var at = start.addingTimeInterval(0.9)
for _ in 0..<40 {
    at = at.addingTimeInterval(0.05)
    beatNow = beatAnalyser.analyse(quiet, now: at).beat
}
check("the beat dies away", beatNow < 0.1, "beat: \(beatNow)")

// Silence after music keeps playing for a moment, then stops
let hold = beatAnalyser.analyse(quiet, now: start.addingTimeInterval(0.8))
check("the music holds through a quiet bar", hold.playing)
let gone = beatAnalyser.analyse(quiet, now: start.addingTimeInterval(3.0))
check("the music stops after the hold", !gone.playing)

if failures == 0 {
    print("all checks passed")
} else {
    print("\(failures) check(s) failed")
    exit(1)
}
