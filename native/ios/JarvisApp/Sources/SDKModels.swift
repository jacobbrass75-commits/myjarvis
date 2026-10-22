import CoreGraphics
import Foundation
import G2Kit
import ImageIO

/// Even Hub SDK JSON (what `CreateStartUpPageContainer.toJson()` etc. produce) -> G2Kit types.
/// Same mapping as native/jarvis-bridge.ts. Keys are camelCase; the protobuf-style names the SDK
/// also accepts (Container_ID, …) are read as a fallback.
enum SDKModels {
    static func int(_ d: [String: Any], _ keys: String...) -> Int? {
        for k in keys {
            if let n = d[k] as? NSNumber { return n.intValue }
            if let s = d[k] as? String, let n = Int(s) { return n }
        }
        return nil
    }

    static func string(_ d: [String: Any], _ keys: String...) -> String? {
        for k in keys { if let s = d[k] as? String { return s } }
        return nil
    }

    private static func objects(_ d: [String: Any], _ keys: String...) -> [[String: Any]] {
        for k in keys { if let a = d[k] as? [[String: Any]] { return a } }
        return []
    }

    private static func nonEmpty(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return " " } // the firmware rejects empty text
        return s
    }

    static func page(from d: [String: Any]) -> PageSpec? {
        let text = objects(d, "textObject", "Text_Object").map { t in
            TextContainer(
                id: int(t, "containerID", "Container_ID") ?? 0, name: string(t, "containerName", "Container_Name"),
                x: int(t, "xPosition", "X_Position") ?? 0, y: int(t, "yPosition", "Y_Position") ?? 0,
                width: int(t, "width", "Width") ?? Display.width, height: int(t, "height", "Height") ?? Display.height,
                borderWidth: int(t, "borderWidth", "Border_Width") ?? 0, borderColor: int(t, "borderColor", "Border_Color") ?? 0,
                borderRadius: int(t, "borderRadius", "Border_Radius") ?? 0, paddingLength: int(t, "paddingLength", "Padding_Length") ?? 0,
                captureEvents: (int(t, "isEventCapture", "Is_event_capture") ?? 0) != 0,
                content: nonEmpty(string(t, "content", "Content"))
            )
        }
        let list = objects(d, "listObject", "List_Object").map { l -> ListContainer in
            let item = l["itemContainer"] as? [String: Any] ?? l["Item_Container"] as? [String: Any] ?? [:]
            let names = item["itemName"] as? [String] ?? item["Item_Name"] as? [String] ?? []
            return ListContainer(
                id: int(l, "containerID", "Container_ID") ?? 0, name: string(l, "containerName", "Container_Name"),
                x: int(l, "xPosition", "X_Position") ?? 0, y: int(l, "yPosition", "Y_Position") ?? 0,
                width: int(l, "width", "Width") ?? Display.width, height: int(l, "height", "Height") ?? Display.height,
                borderWidth: int(l, "borderWidth", "Border_Width") ?? 0, borderColor: int(l, "borderColor", "Border_Color") ?? 0,
                borderRadius: int(l, "borderRadius", "Border_Radius") ?? 0, paddingLength: int(l, "paddingLength", "Padding_Length") ?? 0,
                captureEvents: (int(l, "isEventCapture", "Is_event_capture") ?? 0) != 0,
                items: names, itemWidth: int(item, "itemWidth", "Item_Width") ?? 0,
                selectBorder: (int(item, "isItemSelectBorderEn", "Is_Item_Select_Border_En") ?? 1) != 0
            )
        }
        let image = objects(d, "imageObject", "Image_Object").map { i in
            ImageContainer(
                id: int(i, "containerID", "Container_ID") ?? 0, name: string(i, "containerName", "Container_Name"),
                x: int(i, "xPosition", "X_Position") ?? 0, y: int(i, "yPosition", "Y_Position") ?? 0,
                width: int(i, "width", "Width") ?? 100, height: int(i, "height", "Height") ?? 100
            )
        }
        let spec = PageSpec(text: text, list: list, image: image)
        return text.isEmpty && list.isEmpty && image.isEmpty ? nil : spec
    }

    /// imageData arrives as number[] (SDK toJson of a Uint8Array) or a base64 string.
    static func bytes(_ v: Any?) -> [UInt8]? {
        if let a = v as? [NSNumber] { return a.map { UInt8(truncatingIfNeeded: $0.intValue) } }
        if let s = v as? String {
            let b64 = s.contains(",") ? String(s[s.index(after: s.firstIndex(of: ",")!)...]) : s // data: URLs
            return Data(base64Encoded: b64).map { [UInt8]($0) }
        }
        return nil
    }
}

/// Image payloads -> the 4-bit grey BMP the lenses take. A BMP passes through untouched; PNG/JPEG
/// (what the Even App accepts and converts itself) is decoded, scaled to the container and grey-mapped.
enum ImageConvert {
    static func bmp4(from bytes: [UInt8], width: Int?, height: Int?) -> [UInt8]? {
        if bytes.count > 2, bytes[0] == 0x42, bytes[1] == 0x4D { return bytes }
        guard let src = CGImageSourceCreateWithData(Data(bytes) as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let w = min(max(width ?? img.width, Display.imageMinW), Display.imageMaxW)
        let h = min(max(height ?? img.height, Display.imageMinH), Display.imageMaxH)
        var pixels = [UInt8](repeating: 0, count: w * h)
        let ok = pixels.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return ok ? build4BitBmp(GrayImage(width: w, height: h, pixels: pixels)) : nil
    }
}
