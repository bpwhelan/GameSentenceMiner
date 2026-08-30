#include <windows.h>
#include <roapi.h>

#include <speechapi_cxx.h>

#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <io.h>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace speech = Microsoft::CognitiveServices::Speech;
namespace audio = Microsoft::CognitiveServices::Speech::Audio;

namespace {

constexpr wchar_t kDefaultRuntimePath[] =
    LR"(C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\LiveCaptions)";

// The DirectLiveCaptions packages use the same public compatibility license as
// LunaTranslator's direct-call implementation. A user-provided environment
// variable or license file still takes precedence below.
constexpr char kDefaultEmbeddedSpeechLicense[] =
    "\x4b\x65\x79\x3a\x58\x55\x77\x37\x43\x30\x72\x63\x5a\x41\x49\x51\x76\x47\x38\x33\x37\x59\x50\x34\x46\x31\x4b\x48\x7a\x32\x52\x71\x59\x75\x51\x67\x74\x79\x58\x72\x63\x62\x46\x68\x73\x57\x46\x4e\x47\x6a\x47\x30\x38\x48\x4a\x45\x6c\x6d\x50\x47\x65\x73\x78\x4e\x4d\x62\x69\x62\x30\x73\x38\x79\x33\x39\x4e\x45\x74\x69\x33\x71\x33\x52\x77\x50\x4e\x52\x62\x75\x44\x76\x37\x35\x65\x6a\x5a\x62\x54\x61\x39\x79\x4c\x63\x54\x41\x55\x69\x78\x43";

struct Options {
    std::wstring model_path;
    std::wstring runtime_path = kDefaultRuntimePath;
    std::wstring license_file;
    bool list_models = false;
    bool probe = false;
};

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int required = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr);
    if (required <= 0) {
        throw std::runtime_error("Could not convert a Windows path to UTF-8.");
    }
    std::string result(static_cast<size_t>(required), '\0');
    if (WideCharToMultiByte(
            CP_UTF8,
            WC_ERR_INVALID_CHARS,
            value.data(),
            static_cast<int>(value.size()),
            result.data(),
            required,
            nullptr,
            nullptr) <= 0) {
        throw std::runtime_error("Could not convert a Windows path to UTF-8.");
    }
    return result;
}

std::string JsonEscape(std::string_view value) {
    std::string escaped;
    escaped.reserve(value.size() + 16);
    for (const unsigned char character : value) {
        switch (character) {
        case '\\':
            escaped += "\\\\";
            break;
        case '"':
            escaped += "\\\"";
            break;
        case '\b':
            escaped += "\\b";
            break;
        case '\f':
            escaped += "\\f";
            break;
        case '\n':
            escaped += "\\n";
            break;
        case '\r':
            escaped += "\\r";
            break;
        case '\t':
            escaped += "\\t";
            break;
        default:
            if (character < 0x20) {
                char buffer[7]{};
                std::snprintf(buffer, sizeof(buffer), "\\u%04x", character);
                escaped += buffer;
            } else {
                escaped.push_back(static_cast<char>(character));
            }
            break;
        }
    }
    return escaped;
}

class Reporter {
public:
    void Write(std::string line) {
        std::lock_guard lock(mutex_);
        std::cout << line << '\n' << std::flush;
    }

    void Status(std::string_view status, std::string_view message = {}) {
        std::string line = "{\"type\":\"status\",\"status\":\"";
        line += JsonEscape(status);
        line += "\"";
        if (!message.empty()) {
            line += ",\"message\":\"";
            line += JsonEscape(message);
            line += "\"";
        }
        line += "}";
        Write(std::move(line));
    }

    void Error(std::string_view message) {
        std::string line = "{\"type\":\"error\",\"message\":\"";
        line += JsonEscape(message);
        line += "\"}";
        Write(std::move(line));
    }

    void Model(std::string_view name) {
        std::string line = "{\"type\":\"model\",\"name\":\"";
        line += JsonEscape(name);
        line += "\"}";
        Write(std::move(line));
    }

    void Recognition(bool final, const std::shared_ptr<speech::SpeechRecognitionResult>& result) {
        if (!result) {
            return;
        }
        std::ostringstream line;
        line << "{\"type\":\"recognition\",\"final\":" << (final ? "true" : "false")
             << ",\"text\":\"" << JsonEscape(result->Text) << "\",\"offset\":" << result->Offset()
             << ",\"duration\":" << result->Duration() << "}";
        Write(line.str());
    }

private:
    std::mutex mutex_;
};

[[noreturn]] void UsageError(const std::wstring& message) {
    std::wcerr << L"Error: " << message << L"\n"
               << L"Usage: gsm-windows-speech-recognition --model-path <PATH> [options]\n"
               << L"Options: --runtime-path <PATH> --license-file <PATH> --list-models --probe\n";
    throw std::invalid_argument(WideToUtf8(message));
}

Options ParseOptions(int argc, wchar_t** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::wstring argument = argv[index];
        auto next_value = [&](const wchar_t* name) -> std::wstring {
            if (index + 1 >= argc) {
                UsageError(std::wstring(name) + L" requires a value");
            }
            return argv[++index];
        };
        if (argument == L"--model-path") {
            options.model_path = next_value(L"--model-path");
        } else if (argument == L"--runtime-path") {
            options.runtime_path = next_value(L"--runtime-path");
        } else if (argument == L"--license-file") {
            options.license_file = next_value(L"--license-file");
        } else if (argument == L"--list-models") {
            options.list_models = true;
        } else if (argument == L"--probe") {
            options.probe = true;
        } else if (argument == L"--help" || argument == L"-h") {
            UsageError(L"help requested");
        } else {
            UsageError(L"unknown argument: " + argument);
        }
    }
    if (options.model_path.empty()) {
        UsageError(L"--model-path is required");
    }
    return options;
}

std::string ReadLicense(const std::wstring& license_file) {
    if (license_file.empty()) {
        const wchar_t* environment_license = _wgetenv(L"GSM_WINDOWS_SPEECH_LICENSE");
        return environment_license ? WideToUtf8(environment_license) : std::string(kDefaultEmbeddedSpeechLicense);
    }
    std::ifstream input(std::filesystem::path(license_file), std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open the Windows speech license file.");
    }
    std::ostringstream contents;
    contents << input.rdbuf();
    std::string license = contents.str();
    while (!license.empty() && (license.back() == '\n' || license.back() == '\r')) {
        license.pop_back();
    }
    return license;
}

std::shared_ptr<speech::EmbeddedSpeechConfig> CreateSpeechConfig(
    const Options& options,
    Reporter& reporter,
    const std::string& license) {
    const std::string model_path = WideToUtf8(options.model_path);
    auto config = speech::EmbeddedSpeechConfig::FromPath(model_path);
    const auto models = config->GetSpeechRecognitionModels();
    if (models.empty()) {
        throw std::runtime_error("The selected Windows speech package contains no recognition models.");
    }
    for (const auto& model : models) {
        if (model) {
            reporter.Model(model->Name);
        }
    }
    if (options.list_models) {
        return config;
    }
    for (const auto& model : models) {
        if (model) {
            // System model packages with license-version=0 accept an empty
            // license. Licensed packages can opt in through --license-file;
            // GSM deliberately does not embed a key copied from LunaTranslator.
            config->SetSpeechRecognitionModel(model->Name, license);
        }
    }
    config->SetProfanity(speech::ProfanityOption::Raw);
    return config;
}

int Run(const Options& options) {
    Reporter reporter;

    if (!options.runtime_path.empty()) {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS);
        if (!AddDllDirectory(options.runtime_path.c_str())) {
            reporter.Status("runtime_path_unavailable", WideToUtf8(options.runtime_path));
        }
        // The packaged Live Captions runtime keeps its APP CRT dependencies
        // one directory above the speech DLLs. Use the selected runtime's
        // parent so custom runtime installations work as well.
        const auto runtime_parent = std::filesystem::path(options.runtime_path).parent_path();
        if (!runtime_parent.empty() && !AddDllDirectory(runtime_parent.c_str())) {
            reporter.Status("runtime_parent_unavailable", WideToUtf8(runtime_parent.wstring()));
        }
    }

    const HRESULT ro_result = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(ro_result) && ro_result != RPC_E_CHANGED_MODE) {
        throw std::runtime_error("RoInitialize failed.");
    }
    struct RoGuard {
        bool initialized;
        ~RoGuard() {
            if (initialized) {
                RoUninitialize();
            }
        }
    } ro_guard{SUCCEEDED(ro_result)};

    try {
        const std::string license = ReadLicense(options.license_file);
        auto config = CreateSpeechConfig(options, reporter, license);
        if (options.list_models) {
            return 0;
        }

        auto push_stream = audio::AudioInputStream::CreatePushStream();
        auto audio_config = audio::AudioConfig::FromStreamInput(push_stream);
        auto recognizer = speech::SpeechRecognizer::FromConfig(config, audio_config);

        recognizer->Recognizing.Connect([&reporter](const speech::SpeechRecognitionEventArgs& event) {
            reporter.Recognition(false, event.Result);
        });
        recognizer->Recognized.Connect([&reporter](const speech::SpeechRecognitionEventArgs& event) {
            if (event.Result && event.Result->Reason == speech::ResultReason::RecognizedSpeech) {
                reporter.Recognition(true, event.Result);
            }
        });
        recognizer->Canceled.Connect([&reporter](const speech::SpeechRecognitionCanceledEventArgs& event) {
            std::string message = event.ErrorDetails;
            if (message.empty()) {
                message = "Windows speech recognition was canceled.";
            }
            reporter.Error(message);
        });

        reporter.Status("ready");
        if (options.probe) {
            return 0;
        }

        _setmode(_fileno(stdin), _O_BINARY);
        recognizer->StartContinuousRecognitionAsync().get();
        reporter.Status("started");

        std::vector<uint8_t> buffer(16 * 1024);
        while (std::cin.good()) {
            std::cin.read(reinterpret_cast<char*>(buffer.data()), static_cast<std::streamsize>(buffer.size()));
            const std::streamsize bytes_read = std::cin.gcount();
            if (bytes_read > 0) {
                push_stream->Write(buffer.data(), static_cast<uint32_t>(bytes_read));
            }
        }

        push_stream->Close();
        recognizer->StopContinuousRecognitionAsync().get();
        reporter.Status("stopped");
        return 0;
    } catch (...) {
        throw;
    }
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const Options options = ParseOptions(argc, argv);
        return Run(options);
    } catch (const std::exception& error) {
        std::cerr << "{\"type\":\"error\",\"message\":\"" << JsonEscape(error.what()) << "\"}\n";
        return 1;
    }
}
