// g2input: the computer-use engine's eyes and hands on macOS (src/node/computer.ts runs it).
// macOS built-ins only: CoreGraphics events, the window list, Accessibility and ImageIO.
//
//   g2input selftest                       permissions + parser checks; never posts an event
//   g2input screen                         main display size in points
//   g2input windows                        on-screen windows (app, title, pid, bounds, front)
//   g2input focused                        the focused UI element's app/role (password fields: secure)
//   g2input shrink IN OUT MAXW Q [TW TH]   downscale a screenshot to a JPEG (+ a 4-bit lens thumbnail)
//   g2input move X Y | click X Y [left|right] [1-3] | drag X1 Y1 X2 Y2 | scroll DX DY [X Y]
//   g2input type                           types UTF-8 text read from stdin
//   g2input key cmd+shift+t                a key combo
// Any action with --dry-run checks its arguments and prints what it would do, posting nothing.
// Coordinates are global screen points (the main display's top-left is 0,0). Output is one JSON line.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

var args = Array(CommandLine.arguments.dropFirst())
let dryRun = args.contains("--dry-run")
args.removeAll { $0 == "--dry-run" }

func out(_ obj: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ msg: String, _ code: Int32 = 2) -> Never {
  out(["ok": false, "error": msg])
  exit(code)
}

func num(_ i: Int) -> Double {
  guard i < args.count, let v = Double(args[i]), v.isFinite else { fail("expected a number at argument \(i + 1)") }
  return v
}

// ---------------- keys ----------------

let MODIFIERS: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "super": .maskCommand,
  "shift": .maskShift, "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "opt": .maskAlternate, "option": .maskAlternate, "fn": .maskSecondaryFn,
]

// US ANSI virtual key codes (Carbon kVK_*).
let KEYS: [String: CGKeyCode] = {
  var k: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
    "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
    "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
    "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "return": 0x24, "l": 0x25, "j": 0x26, "'": 0x27,
    "k": 0x28, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "tab": 0x30,
    "space": 0x31, "`": 0x32, "delete": 0x33, "escape": 0x35, "home": 0x73, "pageup": 0x74, "forwarddelete": 0x75,
    "end": 0x77, "pagedown": 0x79, "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
  ]
  for (alias, name) in [("enter", "return"), ("esc", "escape"), ("backspace", "delete"), ("del", "forwarddelete"),
                        ("arrowleft", "left"), ("arrowright", "right"), ("arrowup", "up"), ("arrowdown", "down"),
                        ("pgup", "pageup"), ("pgdn", "pagedown"), ("minus", "-"), ("equal", "="), ("comma", ","),
                        ("period", "."), ("slash", "/")] { k[alias] = k[name] }
  return k
}()

/** "cmd+shift+t" -> (key code, flags); nil if any part is unknown. */
func parseCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
  let parts = combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+", omittingEmptySubsequences: false).map(String.init)
  guard !parts.isEmpty, parts.count <= 5 else { return nil }
  var flags: CGEventFlags = []
  for p in parts.dropLast() {
    guard let m = MODIFIERS[p] else { return nil }
    flags.insert(m)
  }
  // "cmd++" ends in an empty part: that's the "=" key with shift on a US layout; keep it simple and refuse.
  guard let last = parts.last, let code = KEYS[last] else { return nil }
  return (code, flags)
}

// ---------------- events ----------------

let source = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent?) {
  guard let e = e else { fail("could not create the event (is Accessibility granted?)", 3) }
  e.post(tap: .cghidEventTap)
}

func pause(_ ms: UInt32) { usleep(ms * 1000) }

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) -> CGEvent? {
  let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  return e
}

func mainBounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }

func onScreen(_ p: CGPoint) -> Bool {
  // Any display, not just the main one.
  var count: UInt32 = 0
  CGGetDisplaysWithPoint(p, 0, nil, &count)
  return count > 0
}

func point(_ i: Int) -> CGPoint {
  let p = CGPoint(x: num(i), y: num(i + 1))
  guard onScreen(p) else { fail("point \(Int(p.x)),\(Int(p.y)) is off screen") }
  return p
}

// ---------------- windows / focus ----------------

func frontApp() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

func windows() -> [[String: Any]] {
  let front = frontApp()?.processIdentifier
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { w in
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { return nil } // normal windows, not the menu bar or overlays
    let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return [
      "app": w[kCGWindowOwnerName as String] as? String ?? "",
      "title": w[kCGWindowName as String] as? String ?? "", // empty without Screen Recording
      "pid": Int(pid),
      "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0,
      "front": pid == front,
    ]
  }
}

func focused() -> [String: Any] {
  var info: [String: Any] = ["app": frontApp()?.localizedName ?? "", "bundle": frontApp()?.bundleIdentifier ?? "", "trusted": AXIsProcessTrusted()]
  guard AXIsProcessTrusted() else { return info }
  let system = AXUIElementCreateSystemWide()
  var el: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &el) == .success, let element = el else { return info }
  func attr(_ name: String) -> String? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(element as! AXUIElement, name as CFString, &v) == .success ? v as? String : nil
  }
  let role = attr(kAXRoleAttribute) ?? ""
  let subrole = attr(kAXSubroleAttribute) ?? ""
  info["role"] = role
  info["subrole"] = subrole
  info["secure"] = role == "AXSecureTextField" || subrole == "AXSecureTextField"
  return info
}

// ---------------- images ----------------

func shrink(_ input: String, _ output: String, maxW: Int, quality: Double, thumbW: Int?, thumbH: Int?) {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
        let full = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read \(input)") }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceThumbnailMaxPixelSize: max(64, min(maxW, max(full.width, full.height))),
    kCGImageSourceCreateThumbnailWithTransform: true,
  ]
  guard let small = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { fail("cannot scale \(input)") }
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { fail("cannot write \(output)") }
  CGImageDestinationAddImage(dest, small, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { fail("cannot write \(output)") }
  let screen = mainBounds()
  var result: [String: Any] = ["ok": true, "w": small.width, "h": small.height, "screenW": screen.width, "screenH": screen.height]
  if let tw = thumbW, let th = thumbH { result["thumb"] = thumb(full, tw, th) }
  out(result)
}

/** The image fitted (letterboxed) into tw x th, grey levels 0..15, packed two pixels per byte (high nibble first), base64. */
func thumb(_ img: CGImage, _ tw: Int, _ th: Int) -> String {
  var px = [UInt8](repeating: 0, count: tw * th)
  px.withUnsafeMutableBytes { buf in
    guard let ctx = CGContext(data: buf.baseAddress, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: tw,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
    ctx.interpolationQuality = .high
    let s = min(Double(tw) / Double(img.width), Double(th) / Double(img.height))
    let w = Double(img.width) * s, h = Double(img.height) * s
    ctx.draw(img, in: CGRect(x: (Double(tw) - w) / 2, y: (Double(th) - h) / 2, width: w, height: h))
  }
  var packed = [UInt8](repeating: 0, count: (tw * th + 1) / 2)
  for i in 0..<(tw * th) {
    let v = px[i] >> 4
    packed[i / 2] |= i % 2 == 0 ? v << 4 : v
  }
  return Data(packed).base64EncodedString()
}

// ---------------- self-test ----------------

func selftest() {
  var checks: [String] = []
  var ok = true
  func check(_ name: String, _ pass: Bool) {
    checks.append("\(pass ? "ok" : "FAIL") \(name)")
    if !pass { ok = false }
  }
  check("parse cmd+shift+t", parseCombo("cmd+shift+t").map { $0.0 == 0x11 && $0.1.contains(.maskCommand) && $0.1.contains(.maskShift) } ?? false)
  check("parse return", parseCombo("return")?.0 == 0x24)
  check("parse ctrl+alt+delete", parseCombo("ctrl+alt+delete").map { $0.1.contains(.maskControl) && $0.1.contains(.maskAlternate) } ?? false)
  check("reject cmd+nope", parseCombo("cmd+nope") == nil)
  check("reject hyper+a", parseCombo("hyper+a") == nil)
  // Events are created, never posted.
  let p = CGPoint(x: mainBounds().midX, y: mainBounds().midY)
  check("create mouse events", mouse(.leftMouseDown, p, .left) != nil && mouse(.mouseMoved, p, .left) != nil)
  check("create key event", CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: true) != nil)
  check("create scroll event", CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0) != nil)
  check("main display", mainBounds().width > 0)
  out([
    "ok": ok, "checks": checks,
    // Both are reported for the process that is responsible for this one (the daemon's node under launchd).
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "screen": ["w": mainBounds().width, "h": mainBounds().height],
  ])
  exit(ok ? 0 : 1)
}

// ---------------- main ----------------

guard let cmd = args.first else { fail("usage: g2input selftest|screen|windows|focused|shrink|move|click|drag|scroll|type|key [--dry-run]") }

switch cmd {
case "selftest":
  selftest()
case "screen":
  out(["ok": true, "w": mainBounds().width, "h": mainBounds().height])
case "windows":
  out(["ok": true, "windows": windows()])
case "focused":
  out(["ok": true, "focused": focused()])
case "shrink":
  guard args.count >= 5 else { fail("usage: shrink IN OUT MAXW QUALITY [THUMBW THUMBH]") }
  let q = min(1, max(0.1, num(4)))
  shrink(args[1], args[2], maxW: Int(num(3)), quality: q, thumbW: args.count >= 7 ? Int(num(5)) : nil, thumbH: args.count >= 7 ? Int(num(6)) : nil)
case "move":
  let p = point(1)
  if dryRun { out(["ok": true, "dryRun": true, "would": "move \(Int(p.x)),\(Int(p.y))"]); break }
  post(mouse(.mouseMoved, p, .left))
  out(["ok": true])
case "click":
  let p = point(1)
  let right = args.count > 3 && args[3] == "right"
  guard args.count <= 3 || ["left", "right"].contains(args[3]) else { fail("button is left or right") }
  let count = args.count > 4 ? Int(num(4)) : 1
  guard (1...3).contains(count) else { fail("click count is 1 to 3") }
  if dryRun { out(["ok": true, "dryRun": true, "would": "\(right ? "right" : "left") click x\(count) at \(Int(p.x)),\(Int(p.y))"]); break }
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  post(mouse(.mouseMoved, p, button))
  pause(30)
  for i in 1...count {
    post(mouse(down, p, button, clicks: Int64(i)))
    post(mouse(up, p, button, clicks: Int64(i)))
    if i < count { pause(60) }
  }
  out(["ok": true])
case "drag":
  let a = point(1), b = point(3)
  if dryRun { out(["ok": true, "dryRun": true, "would": "drag \(Int(a.x)),\(Int(a.y)) -> \(Int(b.x)),\(Int(b.y))"]); break }
  post(mouse(.mouseMoved, a, .left))
  post(mouse(.leftMouseDown, a, .left))
  for i in 1...12 {
    let t = Double(i) / 12
    pause(16)
    post(mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), .left))
  }
  post(mouse(.leftMouseUp, b, .left))
  out(["ok": true])
case "scroll":
  // dy > 0 scrolls down (content moves up), dx > 0 scrolls right; in lines.
  let dx = Int32(max(-50, min(50, num(1)))), dy = Int32(max(-50, min(50, num(2))))
  let at: CGPoint? = args.count >= 5 ? point(3) : nil
  if dryRun { out(["ok": true, "dryRun": true, "would": "scroll \(dx),\(dy)\(at.map { " at \(Int($0.x)),\(Int($0.y))" } ?? "")"]); break }
  if let at = at { post(mouse(.mouseMoved, at, .left)); pause(30) }
  post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
  out(["ok": true])
case "type":
  let text = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
  guard text.count <= 2000 else { fail("at most 2000 characters at a time") }
  if dryRun { out(["ok": true, "dryRun": true, "would": "type \(text.count) characters"]); break }
  // Short chunks of UTF-16 as unicode key events: any language, no keyboard layout guessing.
  var units = Array(text.utf16)[...]
  while !units.isEmpty {
    let chunk = Array(units.prefix(16))
    units = units.dropFirst(chunk.count)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
      post(e)
    }
    pause(12)
  }
  out(["ok": true])
case "key":
  guard args.count >= 2, let (code, flags) = parseCombo(args[1]) else { fail("unknown key combo") }
  if dryRun { out(["ok": true, "dryRun": true, "would": "key \(args[1].lowercased())", "code": Int(code), "flags": flags.rawValue]); break }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    e?.flags = flags
    post(e)
  }
  out(["ok": true])
default:
  fail("unknown command \(cmd)")
}
