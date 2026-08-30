#include <windows.h>

#include <fcntl.h>
#include <io.h>
#include <sapi.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <cstring>
#include <deque>
#include <climits>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

template <typename T>
class ComPtr final {
public:
    ComPtr() = default;
    explicit ComPtr(T* value) : value_(value) {}
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : value_(other.value_) { other.value_ = nullptr; }

    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            reset();
            value_ = other.value_;
            other.value_ = nullptr;
        }
        return *this;
    }

    ~ComPtr() { reset(); }

    T* get() const { return value_; }
    T* operator->() const { return value_; }
    operator T*() const { return value_; }

    T** put() {
        reset();
        return &value_;
    }

    void reset(T* value = nullptr) {
        if (value_) {
            value_->Release();
        }
        value_ = value;
    }

private:
    T* value_ = nullptr;
};

constexpr WORD kEnglishLanguageId = 1033;
constexpr WORD kJapaneseLanguageId = 1041;
constexpr DWORD kInputSampleRate = 16'000;
constexpr WORD kInputChannels = 1;
constexpr WORD kInputBitsPerSample = 16;

std::mutex g_output_mutex;

struct Options {
    std::wstring language = L"en-US";
    bool probe = false;
    bool onecore = false;
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
        throw std::runtime_error("Could not convert SAPI text to UTF-8.");
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
        throw std::runtime_error("Could not convert SAPI text to UTF-8.");
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
                escaped += static_cast<char>(character);
            }
            break;
        }
    }
    return escaped;
}

std::string HResultString(HRESULT result) {
    std::ostringstream stream;
    stream << "0x" << std::hex << std::uppercase << static_cast<unsigned long>(result);
    return stream.str();
}

void EmitJson(const std::string& json) {
    std::lock_guard lock(g_output_mutex);
    std::cout << json << std::endl;
}

void EmitStatus(const std::string& status, const std::string& detail = {}) {
    std::string json = "{\"type\":\"status\",\"status\":\"" + JsonEscape(status) + "\"";
    if (!detail.empty()) {
        json += ",\"detail\":\"" + JsonEscape(detail) + "\"";
    }
    json += "}";
    EmitJson(json);
}

void EmitError(const std::string& message, HRESULT result = S_OK) {
    std::string json = "{\"type\":\"error\",\"message\":\"" + JsonEscape(message) + "\"";
    if (FAILED(result)) {
        json += ",\"hresult\":\"" + HResultString(result) + "\"";
    }
    json += "}";
    EmitJson(json);
}

Options ParseArgs(int argc, wchar_t** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::wstring argument = argv[index];
        if (argument == L"--language") {
            if (++index >= argc) {
                throw std::runtime_error("--language requires a value");
            }
            options.language = argv[index];
        } else if (argument == L"--probe") {
            options.probe = true;
        } else if (argument == L"--onecore") {
            options.onecore = true;
        } else if (argument == L"--help" || argument == L"-h") {
            throw std::runtime_error(
                "usage: gsm-windows-speech-recognition-sapi --language <locale> [--probe] [--onecore]");
        } else {
            throw std::runtime_error("unknown command-line argument");
        }
    }
    return options;
}

WORD LanguageId(const std::wstring& language) {
    std::wstring normalized = language;
    std::transform(
        normalized.begin(),
        normalized.end(),
        normalized.begin(),
        [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
    if (normalized.find(L"ja") == 0 || normalized.find(L"1041") != std::wstring::npos) {
        return kJapaneseLanguageId;
    }
    return kEnglishLanguageId;
}

class StdinAudioStream final : public ISpAudio {
public:
    StdinAudioStream() {
        event_handle_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!event_handle_) {
            throw std::runtime_error("Could not create the SAPI audio event.");
        }
        format_.wFormatTag = WAVE_FORMAT_PCM;
        format_.nChannels = kInputChannels;
        format_.nSamplesPerSec = kInputSampleRate;
        format_.wBitsPerSample = kInputBitsPerSample;
        format_.nBlockAlign = static_cast<WORD>(format_.nChannels * format_.wBitsPerSample / 8);
        format_.nAvgBytesPerSec = format_.nSamplesPerSec * format_.nBlockAlign;
        format_.cbSize = 0;
    }

    ~StdinAudioStream() {
        if (event_handle_) {
            CloseHandle(event_handle_);
        }
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
        if (!object) {
            return E_POINTER;
        }
        *object = nullptr;
        if (riid == IID_IUnknown || riid == IID_ISequentialStream || riid == IID_IStream ||
            riid == IID_ISpStreamFormat || riid == IID_ISpAudio) {
            *object = static_cast<ISpAudio*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++reference_count_; }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG references = --reference_count_;
        if (references == 0) {
            delete this;
        }
        return references;
    }

    HRESULT STDMETHODCALLTYPE Read(void* destination, ULONG bytes_to_read, ULONG* bytes_read) override {
        if (!destination) {
            return E_POINTER;
        }
        if (bytes_read) {
            *bytes_read = 0;
        }
        if (bytes_to_read == 0) {
            return S_OK;
        }

        std::unique_lock lock(buffer_mutex_);
        buffer_condition_.wait(lock, [this] { return !buffer_.empty() || closed_; });
        if (buffer_.empty() && closed_) {
            return S_FALSE;
        }

        const ULONG count = static_cast<ULONG>(std::min<size_t>(bytes_to_read, buffer_.size()));
        auto* output = static_cast<std::uint8_t*>(destination);
        for (ULONG index = 0; index < count; ++index) {
            output[index] = buffer_.front();
            buffer_.pop_front();
        }
        if (buffer_.empty()) {
            ResetEvent(event_handle_);
        }
        if (bytes_read) {
            *bytes_read = count;
        }
        total_bytes_read_ += count;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Write(const void*, ULONG, ULONG* bytes_written) override {
        if (bytes_written) {
            *bytes_written = 0;
        }
        return STG_E_ACCESSDENIED;
    }

    HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER, DWORD, ULARGE_INTEGER*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE Revert() override { return S_OK; }
    HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }

    HRESULT STDMETHODCALLTYPE Stat(STATSTG* status, DWORD) override {
        if (!status) {
            return E_POINTER;
        }
        std::memset(status, 0, sizeof(*status));
        status->type = STGTY_STREAM;
        status->grfMode = STGM_READ;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Clone(IStream**) override { return E_NOTIMPL; }

    HRESULT STDMETHODCALLTYPE GetFormat(GUID* format_id, WAVEFORMATEX** format) override {
        if (!format) {
            return E_POINTER;
        }
        *format = static_cast<WAVEFORMATEX*>(CoTaskMemAlloc(sizeof(WAVEFORMATEX)));
        if (!*format) {
            return E_OUTOFMEMORY;
        }
        **format = format_;
        if (format_id) {
            *format_id = SPDFID_WaveFormatEx;
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetState(SPAUDIOSTATE new_state, ULONGLONG) override {
        state_.store(new_state);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetFormat(REFGUID format_id, const WAVEFORMATEX* format) override {
        if (!format) {
            return E_POINTER;
        }
        if (format_id != SPDFID_WaveFormatEx || format->wFormatTag != WAVE_FORMAT_PCM ||
            format->nChannels != kInputChannels || format->nSamplesPerSec != kInputSampleRate ||
            format->wBitsPerSample != kInputBitsPerSample) {
            return E_INVALIDARG;
        }
        format_ = *format;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetStatus(SPAUDIOSTATUS* status) override {
        if (!status) {
            return E_POINTER;
        }
        std::lock_guard lock(buffer_mutex_);
        status->cbFreeBuffSpace = LONG_MAX;
        status->cbNonBlockingIO = 0;
        status->State = state_.load();
        status->CurSeekPos = total_bytes_read_;
        status->CurDevicePos = total_bytes_read_;
        status->dwAudioLevel = 0;
        status->dwReserved2 = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetBufferInfo(const SPAUDIOBUFFERINFO* buffer_info) override {
        if (!buffer_info) {
            return E_POINTER;
        }
        buffer_info_ = *buffer_info;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetBufferInfo(SPAUDIOBUFFERINFO* buffer_info) override {
        if (!buffer_info) {
            return E_POINTER;
        }
        *buffer_info = buffer_info_;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetDefaultFormat(GUID* format_id, WAVEFORMATEX** format) override {
        return GetFormat(format_id, format);
    }

    HANDLE STDMETHODCALLTYPE EventHandle() override { return event_handle_; }

    HRESULT STDMETHODCALLTYPE GetVolumeLevel(ULONG* level) override {
        if (!level) {
            return E_POINTER;
        }
        *level = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetVolumeLevel(ULONG) override { return S_OK; }

    HRESULT STDMETHODCALLTYPE GetBufferNotifySize(ULONG* bytes) override {
        if (!bytes) {
            return E_POINTER;
        }
        *bytes = buffer_notify_size_;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetBufferNotifySize(ULONG bytes) override {
        buffer_notify_size_ = bytes;
        return S_OK;
    }

    void Push(const void* data, size_t size) {
        if (!data || size == 0) {
            return;
        }
        {
            std::lock_guard lock(buffer_mutex_);
            const auto* bytes = static_cast<const std::uint8_t*>(data);
            buffer_.insert(buffer_.end(), bytes, bytes + size);
            total_bytes_pushed_ += size;
        }
        SetEvent(event_handle_);
        buffer_condition_.notify_one();
    }

    void Close() {
        {
            std::lock_guard lock(buffer_mutex_);
            closed_ = true;
        }
        SetEvent(event_handle_);
        buffer_condition_.notify_all();
    }

private:
    std::atomic<ULONG> reference_count_{1};
    HANDLE event_handle_ = nullptr;
    WAVEFORMATEX format_{};
    SPAUDIOBUFFERINFO buffer_info_{};
    ULONG buffer_notify_size_ = 0;
    std::atomic<SPAUDIOSTATE> state_{SPAS_RUN};
    std::mutex buffer_mutex_;
    std::condition_variable buffer_condition_;
    std::deque<std::uint8_t> buffer_;
    bool closed_ = false;
    ULONGLONG total_bytes_pushed_ = 0;
    ULONGLONG total_bytes_read_ = 0;
};

void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        throw std::runtime_error(std::string(operation) + " failed with " + HResultString(result));
    }
}

ComPtr<ISpObjectToken> FindRecognizerToken(WORD language_id, bool onecore) {
    ComPtr<ISpObjectTokenCategory> category;
    Check(
        CoCreateInstance(
            CLSID_SpObjectTokenCategory,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(category.put())),
        "CoCreateInstance(CLSID_SpObjectTokenCategory)");
    constexpr wchar_t kOneCoreRecognizerCategory[] =
        L"HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech_OneCore\\Recognizers";
    Check(
        category->SetId(onecore ? kOneCoreRecognizerCategory : SPCAT_RECOGNIZERS, FALSE),
        "ISpObjectTokenCategory::SetId");

    ComPtr<IEnumSpObjectTokens> enumerator;
    Check(category->EnumTokens(nullptr, nullptr, enumerator.put()), "ISpObjectTokenCategory::EnumTokens");

    const std::wstring language_text = std::to_wstring(language_id);
    while (true) {
        ComPtr<ISpObjectToken> token;
        if (enumerator->Next(1, token.put(), nullptr) != S_OK || !token) {
            break;
        }
        LPWSTR token_id = nullptr;
        const HRESULT id_result = token->GetId(&token_id);
        const std::wstring id = token_id ? token_id : L"";
        if (token_id) {
            CoTaskMemFree(token_id);
        }
        if (SUCCEEDED(id_result) && id.find(language_text) != std::wstring::npos) {
            return token;
        }
    }
    throw std::runtime_error("No installed SAPI recognizer matched the requested language.");
}

void EmitRecognitionEvent(const SPEVENT& event) {
    const bool final = event.eEventId == SPEI_RECOGNITION;
    if (!final && event.eEventId != SPEI_HYPOTHESIS) {
        return;
    }
    if (event.elParamType != SPET_LPARAM_IS_OBJECT || event.lParam == 0) {
        return;
    }

    auto* result = reinterpret_cast<ISpRecoResult*>(event.lParam);
    LPWSTR text = nullptr;
    const HRESULT text_result = result->GetText(
        SP_GETWHOLEPHRASE,
        SP_GETWHOLEPHRASE,
        TRUE,
        &text,
        nullptr);
    if (SUCCEEDED(text_result) && text && *text) {
        const std::string utf8_text = WideToUtf8(text);
        std::string json = "{\"type\":\"recognition\",\"final\":";
        json += final ? "true" : "false";
        json += ",\"text\":\"" + JsonEscape(utf8_text) + "\"}";
        EmitJson(json);
    }
    if (text) {
        CoTaskMemFree(text);
    }
}

void ClearEvent(SPEVENT* event) {
    if (!event) {
        return;
    }
    if (event->elParamType == SPET_LPARAM_IS_POINTER || event->elParamType == SPET_LPARAM_IS_STRING) {
        CoTaskMemFree(reinterpret_cast<void*>(event->lParam));
    } else if (event->elParamType == SPET_LPARAM_IS_TOKEN || event->elParamType == SPET_LPARAM_IS_OBJECT) {
        reinterpret_cast<IUnknown*>(event->lParam)->Release();
    }
    std::memset(event, 0, sizeof(*event));
}

void DrainEvents(ISpRecoContext* context) {
    SPEVENT events[32]{};
    ULONG fetched = 0;
    while (SUCCEEDED(context->GetEvents(32, events, &fetched)) && fetched > 0) {
        for (ULONG index = 0; index < fetched; ++index) {
            EmitRecognitionEvent(events[index]);
            ClearEvent(&events[index]);
        }
        if (fetched < 32) {
            break;
        }
        fetched = 0;
    }
}

void Run(const Options& options) {
    Check(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED), "CoInitializeEx");
    struct ComGuard {
        ~ComGuard() { CoUninitialize(); }
    } com_guard;

    const WORD language_id = LanguageId(options.language);
    ComPtr<ISpObjectToken> token = FindRecognizerToken(language_id, options.onecore);

    ComPtr<ISpRecognizer> recognizer;
    Check(
        CoCreateInstance(
            CLSID_SpInprocRecognizer,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(recognizer.put())),
        "CoCreateInstance(CLSID_SpInprocRecognizer)");
    Check(recognizer->SetRecognizer(token), "ISpRecognizer::SetRecognizer");

    ComPtr<StdinAudioStream> audio_stream(new StdinAudioStream());
    Check(recognizer->SetInput(audio_stream, TRUE), "ISpRecognizer::SetInput");

    ComPtr<ISpRecoContext> context;
    Check(recognizer->CreateRecoContext(context.put()), "ISpRecognizer::CreateRecoContext");
    Check(context->SetNotifyWin32Event(), "ISpRecoContext::SetNotifyWin32Event");
    Check(
        context->SetInterest(
            SPFEI(SPEI_RECOGNITION) | SPFEI(SPEI_HYPOTHESIS) | SPFEI(SPEI_FALSE_RECOGNITION),
            SPFEI(SPEI_RECOGNITION) | SPFEI(SPEI_HYPOTHESIS) | SPFEI(SPEI_FALSE_RECOGNITION)),
        "ISpRecoContext::SetInterest");

    ComPtr<ISpRecoGrammar> grammar;
    Check(context->CreateGrammar(0, grammar.put()), "ISpRecoContext::CreateGrammar");
    Check(grammar->LoadDictation(nullptr, SPLO_STATIC), "ISpRecoGrammar::LoadDictation");
    Check(grammar->SetDictationState(SPRS_ACTIVE), "ISpRecoGrammar::SetDictationState");
    Check(recognizer->SetRecoState(SPRST_ACTIVE), "ISpRecognizer::SetRecoState");

    EmitJson(
        "{\"type\":\"status\",\"status\":\"ready\",\"backend\":\"sapi\",\"language\":\"" +
        JsonEscape(WideToUtf8(options.language)) + "\"}");
    if (options.probe) {
        return;
    }

    _setmode(_fileno(stdin), _O_BINARY);
    std::atomic<bool> input_done = false;
    std::thread input_thread([&] {
        std::vector<std::uint8_t> input_buffer(64 * 1024);
        while (std::cin) {
            std::cin.read(reinterpret_cast<char*>(input_buffer.data()), static_cast<std::streamsize>(input_buffer.size()));
            const std::streamsize bytes_read = std::cin.gcount();
            if (bytes_read > 0) {
                audio_stream->Push(input_buffer.data(), static_cast<size_t>(bytes_read));
            }
            if (bytes_read <= 0) {
                break;
            }
        }
        audio_stream->Close();
        input_done.store(true);
    });

    const HANDLE notify_handle = context->GetNotifyEventHandle();
    while (!input_done.load()) {
        const DWORD wait_result = WaitForSingleObject(notify_handle, 100);
        if (wait_result == WAIT_OBJECT_0) {
            DrainEvents(context);
        } else if (wait_result == WAIT_FAILED) {
            break;
        }
    }

    // Give SAPI a short opportunity to deliver a final recognition after the
    // capture pipe closes. In normal operation the audio helper remains open.
    const ULONGLONG drain_deadline = GetTickCount64() + 3000;
    while (GetTickCount64() < drain_deadline) {
        DrainEvents(context);
        if (WaitForSingleObject(notify_handle, 100) == WAIT_FAILED) {
            break;
        }
    }
    DrainEvents(context);
    if (input_thread.joinable()) {
        input_thread.join();
    }
    recognizer->SetRecoState(SPRST_INACTIVE);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        Run(ParseArgs(argc, argv));
        return 0;
    } catch (const std::exception& error) {
        EmitError(error.what());
        return 1;
    }
}
