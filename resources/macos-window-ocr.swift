/**
 * macOS Focused-Window OCR
 *
 * One-shot process: captures the frontmost application's focused window and
 * recognizes its text with the Vision framework. Emits a single JSON object on
 * stdout and exits.
 *
 *   { "ok": true, "text": "...", "window": "App — Title", "durationMs": 123 }
 *   { "ok": false, "error": "reason" }
 *
 * The capture is scoped to one window rather than the whole display: it yields
 * far less irrelevant chrome to match against, and narrows the privacy surface.
 * OpenWhispr's own windows are skipped so the dictation overlay (which is
 * always-on-top and may be frontmost) never becomes the OCR target.
 *
 * Requires Screen Recording permission and macOS 14+ (SCScreenshotManager).
 *
 * Compile: swiftc -O macos-window-ocr.swift -o macos-window-ocr \
 *            -framework ScreenCaptureKit -framework Vision -framework AppKit
 */

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

// MARK: - Output

func emitJSON(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
        let json = String(data: data, encoding: .utf8)
    {
        print(json)
    } else {
        print("{\"ok\":false,\"error\":\"failed to serialize result\"}")
    }
    fflush(stdout)
}

func fail(_ reason: String) -> Never {
    emitJSON(["ok": false, "error": reason])
    exit(0)  // Exit 0: an unavailable window is a normal outcome, not a crash.
}

// MARK: - Arguments

// Recognition is capped so a dense window can't stall the dictation pipeline.
var timeoutSeconds: Double = 4.0
var excludePID: pid_t = 0

let args = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < args.count {
    switch args[index] {
    case "--timeout":
        if index + 1 < args.count, let value = Double(args[index + 1]) { timeoutSeconds = value }
        index += 2
    case "--exclude-pid":
        if index + 1 < args.count, let value = Int32(args[index + 1]) { excludePID = value }
        index += 2
    default:
        index += 1
    }
}

// MARK: - Window selection

// CGWindowListCopyWindowInfo, unlike SCShareableContent, returns windows already
// ordered front-to-back — index 0 is whatever is on top of the screen. That ordering
// is what tells apart which of an app's *own* windows is the one actually in front:
// an app with several open windows (several Chrome windows, several Finder windows)
// has one PID but only one of them is on top, and area has nothing to do with that.
func frontToBackWindowIDs() -> [CGWindowID] {
    guard
        let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
            as? [[String: AnyObject]]
    else { return [] }
    return list.compactMap { info in
        (info[kCGWindowNumber as String] as? NSNumber).map { CGWindowID($0.uint32Value) }
    }
}

@available(macOS 14.0, *)
func focusedWindow(from content: SCShareableContent) -> SCWindow? {
    let ownPID = excludePID != 0 ? excludePID : ProcessInfo.processInfo.processIdentifier
    let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

    let candidates = content.windows.filter { window in
        guard window.isOnScreen else { return false }
        guard let app = window.owningApplication else { return false }
        if app.processID == ownPID { return false }
        // Menu bar, dock and other chrome live above the normal window layer.
        guard window.windowLayer == 0 else { return false }
        // Ignore slivers: tooltips, notification banners, 1px helper windows.
        return window.frame.width > 200 && window.frame.height > 120
    }

    // Missing from this map (not currently on screen at all, e.g. minimized) sorts
    // last rather than crashing the comparison.
    let frontToBack = frontToBackWindowIDs()
    let zOrder = Dictionary(uniqueKeysWithValues: frontToBack.enumerated().map { ($1, $0) })
    let topmost: (SCWindow, SCWindow) -> Bool = { a, b in
        (zOrder[a.windowID] ?? Int.max) < (zOrder[b.windowID] ?? Int.max)
    }

    // Prefer the frontmost app's topmost window over its other windows — not its
    // largest, which picks the wrong one whenever that app has more than one window
    // open and the one in front isn't the biggest.
    if let frontPID,
        let match = candidates
            .filter({ $0.owningApplication?.processID == frontPID })
            .min(by: topmost)
    {
        return match
    }

    // The frontmost app may be OpenWhispr itself (or have no capturable window),
    // in which case the topmost remaining window is the best guess at context.
    return candidates.min(by: topmost)
}

// MARK: - OCR

func recognizeText(in image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Screen text is already crisp; language correction mainly rewrites the
    // identifiers and product names we specifically want reported verbatim.
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    guard let observations = request.results else { return "" }
    return observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

@available(macOS 14.0, *)
func backingScale(for window: SCWindow, displays: [SCDisplay]) -> CGFloat {
    // NSScreen.main describes the menu-bar display, not necessarily the display that
    // contains the focused window. On a mixed Retina/non-Retina setup that either
    // downscales the OCR input or asks ScreenCaptureKit for twice the real dimensions.
    // SCDisplay frames and SCWindow frames share ScreenCaptureKit's coordinate space, so
    // choose the display containing the largest part of the window and derive its scale
    // from logical points versus captured pixels.
    let display = displays.max { left, right in
        let leftIntersection = left.frame.intersection(window.frame)
        let rightIntersection = right.frame.intersection(window.frame)
        let leftArea = leftIntersection.isNull ? 0 : leftIntersection.width * leftIntersection.height
        let rightArea = rightIntersection.isNull ? 0 : rightIntersection.width * rightIntersection.height
        return leftArea < rightArea
    }
    guard let display, display.frame.width > 0 else { return 2.0 }
    return CGFloat(display.width) / display.frame.width
}

// MARK: - Main

guard #available(macOS 14.0, *) else {
    fail("requires macOS 14 or later")
}

let started = Date()

// A hung ScreenCaptureKit call must not hold the dictation pipeline open.
let watchdog = DispatchSource.makeTimerSource(queue: .global())
watchdog.schedule(deadline: .now() + timeoutSeconds)
watchdog.setEventHandler {
    fail("timed out after \(timeoutSeconds)s")
}
watchdog.resume()

Task {
    do {
        // Throws if Screen Recording permission has not been granted.
        let content = try await SCShareableContent.excludingDesktopWindows(
            true, onScreenWindowsOnly: true)

        guard let window = focusedWindow(from: content) else {
            fail("no capturable window found")
        }

        let config = SCStreamConfiguration()
        // Capture at the window's backing resolution; Vision reads small text
        // far more reliably than it does a downscaled screenshot.
        let scale = backingScale(for: window, displays: content.displays)
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.showsCursor = false
        config.captureResolution = .best

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: config)

        let text = try recognizeText(in: image)
        watchdog.cancel()

        let appName = window.owningApplication?.applicationName ?? "unknown"
        let title = window.title ?? ""
        emitJSON([
            "ok": true,
            "text": text,
            "window": title.isEmpty ? appName : "\(appName) — \(title)",
            "durationMs": Int(Date().timeIntervalSince(started) * 1000),
        ])
        exit(0)
    } catch {
        watchdog.cancel()
        fail("\(error.localizedDescription)")
    }
}

RunLoop.main.run()
