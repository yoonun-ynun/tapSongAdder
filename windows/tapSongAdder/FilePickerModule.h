#pragma once
#include "pch.h"
#include "NativeModules.h"
#include <shobjidl.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace winrt::YourAppNamespace {

namespace React = winrt::Microsoft::ReactNative;

namespace detail {

struct CoTaskMemStr {
  PWSTR ptr{nullptr};
  ~CoTaskMemStr() {
    if (ptr) {
      CoTaskMemFree(ptr);
    }
  }
};

struct ComInitGuard {
  HRESULT hr{E_FAIL};
  ComInitGuard() {
    hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  }
  ~ComInitGuard() {
    if (hr == S_OK || hr == S_FALSE) {
      CoUninitialize();
    }
  }
};

inline std::filesystem::path ToFsPath(std::string const& utf8Path) {
  auto wide = winrt::to_hstring(utf8Path);
  return std::filesystem::path(std::wstring_view(wide));
}

inline std::string FromFsPath(std::filesystem::path const& fsPath) {
  return winrt::to_string(fsPath.wstring());
}

inline std::string GetShellItemPath(IShellItem* item) {
  CoTaskMemStr path;
  winrt::check_hresult(item->GetDisplayName(SIGDN_FILESYSPATH, &path.ptr));
  return winrt::to_string(path.ptr);
}

inline HWND GetOwnerWindow() {
  HWND hwnd = GetActiveWindow();
  return hwnd ? hwnd : GetForegroundWindow();
}

inline bool GetBoolOption(React::JSValueObject const& options, std::string const& key) {
  auto it = options.find(key);
  return it != options.end() && it->second.AsBoolean();
}

inline std::string Base64Encode(std::vector<uint8_t> const& data) {
  static constexpr char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((data.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < data.size()) {
    uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                 (static_cast<uint32_t>(data[i + 1]) << 8) |
                 static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(v >> 18) & 0x3F]);
    out.push_back(kTable[(v >> 12) & 0x3F]);
    out.push_back(kTable[(v >> 6) & 0x3F]);
    out.push_back(kTable[v & 0x3F]);
    i += 3;
  }
  if (i < data.size()) {
    uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    bool hasSecond = (i + 1 < data.size());
    if (hasSecond) {
      v |= static_cast<uint32_t>(data[i + 1]) << 8;
    }
    out.push_back(kTable[(v >> 18) & 0x3F]);
    out.push_back(kTable[(v >> 12) & 0x3F]);
    out.push_back(hasSecond ? kTable[(v >> 6) & 0x3F] : '=');
    out.push_back('=');
  }
  return out;
}

inline int Base64Value(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

inline std::vector<uint8_t> Base64Decode(std::string const& input) {
  std::vector<uint8_t> out;
  out.reserve((input.size() / 4) * 3);
  uint32_t buf = 0;
  int bits = 0;
  for (unsigned char c : input) {
    if (c == '=') break;
    int val = Base64Value(c);
    if (val < 0) continue;
    buf = (buf << 6) | static_cast<uint32_t>(val);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buf >> bits) & 0xFF));
    }
  }
  return out;
}

} // namespace detail

REACT_MODULE(FilePicker)
struct FilePicker {
  REACT_INIT(Initialize)
  void Initialize(React::ReactContext const& reactContext) noexcept {
    m_context = reactContext;
  }

  // 파일(단일/다중) 또는 폴더 선택
  REACT_METHOD(pick)
  void pick(React::JSValueObject options,
            React::ReactPromise<std::vector<std::string>> promise) noexcept {
    bool isDirectory = detail::GetBoolOption(options, "directory");
    bool multiple = detail::GetBoolOption(options, "multiple");

    m_context.UIDispatcher().Post([isDirectory, multiple, promise]() {
      try {
        detail::ComInitGuard com;
        winrt::com_ptr<IFileOpenDialog> dialog;
        winrt::check_hresult(CoCreateInstance(
            CLSID_FileOpenDialog,
            nullptr,
            CLSCTX_INPROC_SERVER,
            __uuidof(IFileOpenDialog),
            dialog.put_void()));

        DWORD flags = 0;
        winrt::check_hresult(dialog->GetOptions(&flags));
        flags |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
        flags |= isDirectory ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST;
        if (multiple) {
          flags |= FOS_ALLOWMULTISELECT;
        }
        winrt::check_hresult(dialog->SetOptions(flags));

        HRESULT hr = dialog->Show(detail::GetOwnerWindow());
        if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
          promise.Resolve(std::vector<std::string>{});
          return;
        }
        winrt::check_hresult(hr);

        std::vector<std::string> results;
        if (multiple) {
          winrt::com_ptr<IShellItemArray> items;
          winrt::check_hresult(dialog->GetResults(items.put()));
          DWORD count = 0;
          winrt::check_hresult(items->GetCount(&count));
          for (DWORD i = 0; i < count; ++i) {
            winrt::com_ptr<IShellItem> item;
            winrt::check_hresult(items->GetItemAt(i, item.put()));
            results.push_back(detail::GetShellItemPath(item.get()));
          }
        } else {
          winrt::com_ptr<IShellItem> item;
          winrt::check_hresult(dialog->GetResult(item.put()));
          results.push_back(detail::GetShellItemPath(item.get()));
        }

        promise.Resolve(results);
      } catch (winrt::hresult_error const& e) {
        promise.Reject(winrt::to_string(e.message()).c_str());
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::pick");
      }
    });
  }

  // 저장 경로 선택
  REACT_METHOD(pickSave)
  void pickSave(std::string defaultFileName,
                React::ReactPromise<std::string> promise) noexcept {
    m_context.UIDispatcher().Post([defaultFileName = std::move(defaultFileName), promise]() {
      try {
        detail::ComInitGuard com;
        winrt::com_ptr<IFileSaveDialog> dialog;
        winrt::check_hresult(CoCreateInstance(
            CLSID_FileSaveDialog,
            nullptr,
            CLSCTX_INPROC_SERVER,
            __uuidof(IFileSaveDialog),
            dialog.put_void()));

        DWORD flags = 0;
        winrt::check_hresult(dialog->GetOptions(&flags));
        flags |= FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT;
        winrt::check_hresult(dialog->SetOptions(flags));

        if (!defaultFileName.empty()) {
          winrt::check_hresult(dialog->SetFileName(winrt::to_hstring(defaultFileName).c_str()));
        }

        HRESULT hr = dialog->Show(detail::GetOwnerWindow());
        if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
          promise.Resolve(std::string{});
          return;
        }
        winrt::check_hresult(hr);

        winrt::com_ptr<IShellItem> item;
        winrt::check_hresult(dialog->GetResult(item.put()));
        promise.Resolve(detail::GetShellItemPath(item.get()));
      } catch (winrt::hresult_error const& e) {
        promise.Reject(winrt::to_string(e.message()).c_str());
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::pickSave");
      }
    });
  }

  // 파일 읽기 (encoding: "utf8" | "base64")
  REACT_METHOD(readFile)
  void readFile(std::string path,
                std::string encoding,
                React::ReactPromise<std::string> promise) noexcept {
    std::thread([path = std::move(path), encoding = std::move(encoding), promise]() {
      try {
        std::ifstream file(detail::ToFsPath(path), std::ios::binary | std::ios::ate);
        if (!file) {
          throw std::runtime_error("Failed to open file for reading: " + path);
        }
        auto size = file.tellg();
        if (size < 0) {
          throw std::runtime_error("Failed to determine file size: " + path);
        }
        file.seekg(0, std::ios::beg);

        if (encoding == "base64") {
          std::vector<uint8_t> buf(static_cast<size_t>(size));
          if (size > 0 && !file.read(reinterpret_cast<char*>(buf.data()), size)) {
            throw std::runtime_error("Failed to read binary file: " + path);
          }
          promise.Resolve(detail::Base64Encode(buf));
        } else {
          std::string text(static_cast<size_t>(size), '\0');
          if (size > 0 && !file.read(text.data(), size)) {
            throw std::runtime_error("Failed to read text file: " + path);
          }
          promise.Resolve(text);
        }
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::readFile");
      }
    }).detach();
  }

  // 파일 쓰기 (encoding: "utf8" | "base64", 상위 폴더 자동 생성)
  REACT_METHOD(writeFile)
  void writeFile(std::string path,
                 std::string data,
                 std::string encoding,
                 React::ReactPromise<bool> promise) noexcept {
    std::thread([path = std::move(path),
                 data = std::move(data),
                 encoding = std::move(encoding),
                 promise]() {
      try {
        auto fsPath = detail::ToFsPath(path);
        if (fsPath.has_parent_path()) {
          std::filesystem::create_directories(fsPath.parent_path());
        }

        std::ofstream file(fsPath, std::ios::binary | std::ios::trunc);
        if (!file) {
          throw std::runtime_error("Failed to open file for writing: " + path);
        }

        if (encoding == "base64") {
          auto bytes = detail::Base64Decode(data);
          if (!bytes.empty()) {
            file.write(
                reinterpret_cast<const char*>(bytes.data()),
                static_cast<std::streamsize>(bytes.size()));
          }
        } else if (!data.empty()) {
          file.write(data.data(), static_cast<std::streamsize>(data.size()));
        }

        if (!file) {
          throw std::runtime_error("Failed to write file: " + path);
        }
        promise.Resolve(true);
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::writeFile");
      }
    }).detach();
  }

  // 디렉터리 내부 항목 조회
  REACT_METHOD(readDir)
  void readDir(std::string path,
               React::ReactPromise<React::JSValueArray> promise) noexcept {
    std::thread([path = std::move(path), promise]() {
      try {
        React::JSValueArray entries;
        for (auto const& entry : std::filesystem::directory_iterator(detail::ToFsPath(path))) {
          React::JSValueObject item;
          item["name"] = detail::FromFsPath(entry.path().filename());
          item["path"] = detail::FromFsPath(entry.path());
          bool isDir = entry.is_directory();
          item["isDirectory"] = isDir;
          std::error_code ec;
          auto size = isDir ? 0ULL : entry.file_size(ec);
          item["size"] = static_cast<int64_t>(ec ? 0ULL : size);
          entries.push_back(std::move(item));
        }
        promise.Resolve(entries);
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::readDir");
      }
    }).detach();
  }

  // 파일 복사 (기존 파일 덮어쓰기, 상위 폴더 자동 생성)
  REACT_METHOD(copyFile)
  void copyFile(std::string srcPath,
                std::string destPath,
                React::ReactPromise<bool> promise) noexcept {
    std::thread([srcPath = std::move(srcPath), destPath = std::move(destPath), promise]() {
      try {
        auto dst = detail::ToFsPath(destPath);
        if (dst.has_parent_path()) {
          std::filesystem::create_directories(dst.parent_path());
        }
        std::filesystem::copy_file(
            detail::ToFsPath(srcPath),
            dst,
            std::filesystem::copy_options::overwrite_existing);
        promise.Resolve(true);
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::copyFile");
      }
    }).detach();
  }

  // 폴더 생성 (중첩 경로 포함)
  REACT_METHOD(mkdir)
  void mkdir(std::string path, React::ReactPromise<bool> promise) noexcept {
    std::thread([path = std::move(path), promise]() {
      try {
        std::filesystem::create_directories(detail::ToFsPath(path));
        promise.Resolve(true);
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::mkdir");
      }
    }).detach();
  }

  // 파일 또는 폴더 재귀 삭제
  REACT_METHOD(remove)
  void remove(std::string path, React::ReactPromise<bool> promise) noexcept {
    std::thread([path = std::move(path), promise]() {
      try {
        std::filesystem::remove_all(detail::ToFsPath(path));
        promise.Resolve(true);
      } catch (std::exception const& e) {
        promise.Reject(e.what());
      } catch (...) {
        promise.Reject("Unknown error in FilePicker::remove");
      }
    }).detach();
  }

  // 경로 존재 여부 확인
  REACT_METHOD(exists)
  void exists(std::string path, React::ReactPromise<bool> promise) noexcept {
    std::thread([path = std::move(path), promise]() {
      std::error_code ec;
      bool found = std::filesystem::exists(detail::ToFsPath(path), ec);
      promise.Resolve(!ec && found);
    }).detach();
  }

private:
  React::ReactContext m_context{nullptr};
};

} // namespace winrt::YourAppNamespace