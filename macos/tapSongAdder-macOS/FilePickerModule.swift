import AppKit
import Foundation

@objc(FilePicker)
class FilePicker: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc
  func pick(_ options: NSDictionary,
            resolver resolve: @escaping RCTPromiseResolveBlock,
            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let pickDirectory = (options["directory"] as? Bool) ?? false
    let multiple = (options["multiple"] as? Bool) ?? false

    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.canChooseFiles = !pickDirectory
      panel.canChooseDirectories = pickDirectory
      panel.allowsMultipleSelection = multiple
      panel.canCreateDirectories = true

      panel.begin { response in
        if response == .OK {
          resolve(panel.urls.map { $0.path })
        } else {
          resolve([])
        }
      }
    }
  }

  @objc
  func pickSave(_ defaultFileName: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let panel = NSSavePanel()
      panel.canCreateDirectories = true
      if !defaultFileName.isEmpty {
        panel.nameFieldStringValue = defaultFileName
      }

      panel.begin { response in
        if response == .OK, let url = panel.url {
          resolve(url.path)
        } else {
          resolve("")
        }
      }
    }
  }

  @objc
  func readFile(_ path: String,
                encoding: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let url = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: url)
        if encoding == "base64" {
          resolve(data.base64EncodedString())
        } else {
          guard let text = String(data: data, encoding: .utf8) else {
            reject("E_ENCODING", "File is not valid UTF-8: \(path)", nil)
            return
          }
          resolve(text)
        }
      } catch {
        reject("E_READ", error.localizedDescription, error)
      }
    }
  }

  @objc
  func writeFile(_ path: String,
                 data: String,
                 encoding: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let url = URL(fileURLWithPath: path)
        let parent = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

        if encoding == "base64" {
          guard let raw = Data(base64Encoded: data, options: .ignoreUnknownCharacters) else {
            reject("E_BASE64", "Invalid base64 payload", nil)
            return
          }
          try raw.write(to: url, options: .atomic)
        } else {
          try data.write(to: url, atomically: true, encoding: .utf8)
        }
        resolve(true)
      } catch {
        reject("E_WRITE", error.localizedDescription, error)
      }
    }
  }

  @objc
  func readDir(_ path: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let url = URL(fileURLWithPath: path)
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey]
        let items = try FileManager.default.contentsOfDirectory(
          at: url,
          includingPropertiesForKeys: keys
        )
        let result: [[String: Any]] = items.map { itemUrl in
          let values = try? itemUrl.resourceValues(forKeys: Set(keys))
          let isDir = values?.isDirectory ?? false
          let size = isDir ? 0 : (values?.fileSize ?? 0)
          return [
            "name": itemUrl.lastPathComponent,
            "path": itemUrl.path,
            "isDirectory": isDir,
            "size": size,
          ]
        }
        resolve(result)
      } catch {
        reject("E_READDIR", error.localizedDescription, error)
      }
    }
  }

  @objc
  func copyFile(_ srcPath: String,
                destPath: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let fm = FileManager.default
        let srcUrl = URL(fileURLWithPath: srcPath)
        let destUrl = URL(fileURLWithPath: destPath)
        try fm.createDirectory(
          at: destUrl.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        if fm.fileExists(atPath: destPath) {
          try fm.removeItem(at: destUrl)
        }
        try fm.copyItem(at: srcUrl, to: destUrl)
        resolve(true)
      } catch {
        reject("E_COPY", error.localizedDescription, error)
      }
    }
  }

  @objc
  func mkdir(_ path: String,
             resolver resolve: @escaping RCTPromiseResolveBlock,
             rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try FileManager.default.createDirectory(
          atPath: path,
          withIntermediateDirectories: true
        )
        resolve(true)
      } catch {
        reject("E_MKDIR", error.localizedDescription, error)
      }
    }
  }

  @objc
  func remove(_ path: String,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let fm = FileManager.default
        if fm.fileExists(atPath: path) {
          try fm.removeItem(atPath: path)
        }
        resolve(true)
      } catch {
        reject("E_REMOVE", error.localizedDescription, error)
      }
    }
  }

  @objc
  func exists(_ path: String,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      resolve(FileManager.default.fileExists(atPath: path))
    }
  }
}