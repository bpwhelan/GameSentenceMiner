use std::env;

#[derive(Debug, PartialEq, Eq)]
struct Options {
    root_pid: u32,
    probe: bool,
    sample_rate: u32,
    channels: u16,
}

fn parse_args<I>(args: I) -> Result<Options, String>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    let _program = args.next();
    let mut root_pid = None;
    let mut probe = false;
    let mut sample_rate = 48_000;
    let mut channels = 2;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root-pid" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--root-pid requires a value".to_string())?;
                let pid = value
                    .parse::<u32>()
                    .map_err(|_| "--root-pid must be a positive integer".to_string())?;
                if pid == 0 {
                    return Err("--root-pid must be greater than zero".to_string());
                }
                root_pid = Some(pid);
            }
            "--probe" => probe = true,
            "--sample-rate" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--sample-rate requires a value".to_string())?;
                sample_rate = value
                    .parse::<u32>()
                    .map_err(|_| "--sample-rate must be a positive integer".to_string())?;
                if sample_rate == 0 {
                    return Err("--sample-rate must be greater than zero".to_string());
                }
            }
            "--channels" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--channels requires a value".to_string())?;
                channels = value
                    .parse::<u16>()
                    .map_err(|_| "--channels must be a positive integer".to_string())?;
                if channels == 0 {
                    return Err("--channels must be greater than zero".to_string());
                }
            }
            "--help" | "-h" => {
                return Err(
                    "usage: gsm-windows-audio-capture --root-pid <PID> [--sample-rate <HZ>] [--channels <COUNT>]"
                        .to_string(),
                )
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Options {
        root_pid: root_pid.ok_or_else(|| "--root-pid is required".to_string())?,
        probe,
        sample_rate,
        channels,
    })
}

fn emit_event(level: &str, code: &str, message: &str) {
    let escaped = message
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    eprintln!("{{\"level\":\"{level}\",\"code\":\"{code}\",\"message\":\"{escaped}\"}}");
}

fn pcm_byte_count(frames: usize, channels: usize) -> usize {
    frames * channels * (16 / 8)
}

#[cfg(test)]
fn silent_pcm_packet(frames: usize, channels: usize) -> Vec<u8> {
    vec![0; pcm_byte_count(frames, channels)]
}

#[cfg(windows)]
mod platform {
    use super::{emit_event, pcm_byte_count};
    use std::io::{self, Write};
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use std::slice;
    use std::sync::atomic::{AtomicU32, Ordering};
    use winapi::ctypes::c_void;
    use winapi::shared::guiddef::{IsEqualGUID, GUID, REFIID};
    use winapi::shared::minwindef::{BYTE, DWORD, FALSE, TRUE, ULONG};
    use winapi::shared::mmreg::{WAVEFORMATEX, WAVE_FORMAT_PCM};
    use winapi::shared::ntdef::HRESULT;
    use winapi::shared::winerror::{E_NOINTERFACE, E_POINTER, S_OK, WAIT_TIMEOUT};
    use winapi::shared::wtypes::VT_BLOB;
    use winapi::shared::wtypesbase::BLOB;
    use winapi::um::audioclient::{
        IAudioCaptureClient, IAudioClient, IID_IAudioCaptureClient, IID_IAudioClient,
        AUDCLNT_BUFFERFLAGS_SILENT,
    };
    use winapi::um::audiosessiontypes::{
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use winapi::um::combaseapi::{CoInitializeEx, CoUninitialize};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::mmdeviceapi::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandlerVtbl,
    };
    use winapi::um::objbase::COINIT_MULTITHREADED;
    use winapi::um::propidl::PROPVARIANT;
    use winapi::um::synchapi::{CreateEventW, SetEvent, WaitForSingleObject};
    use winapi::um::unknwnbase::{IUnknown, IUnknownVtbl};
    use winapi::um::winbase::{INFINITE, WAIT_OBJECT_0};
    use winapi::Interface;

    const PROCESS_LOOPBACK_INCLUDE_TARGET_PROCESS_TREE: i32 = 0;
    const AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK: i32 = 1;
    const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: DWORD = 0x8000_0000;
    const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: DWORD = 0x0800_0000;
    const IID_IAGILE_OBJECT: GUID = GUID {
        Data1: 0x94ea2b94,
        Data2: 0xe9cc,
        Data3: 0x49e0,
        Data4: [0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90],
    };
    const DEVICE_PATH: [u16; 21] = [
        b'V' as u16,
        b'A' as u16,
        b'D' as u16,
        b'\\' as u16,
        b'P' as u16,
        b'r' as u16,
        b'o' as u16,
        b'c' as u16,
        b'e' as u16,
        b's' as u16,
        b's' as u16,
        b'_' as u16,
        b'L' as u16,
        b'o' as u16,
        b'o' as u16,
        b'p' as u16,
        b'b' as u16,
        b'a' as u16,
        b'c' as u16,
        b'k' as u16,
        0,
    ];

    #[repr(C)]
    struct AudioClientProcessLoopbackParams {
        target_process_id: DWORD,
        process_loopback_mode: i32,
    }

    #[repr(C)]
    struct AudioClientActivationParams {
        activation_type: i32,
        process_loopback_params: AudioClientProcessLoopbackParams,
    }

    #[repr(C)]
    struct CompletionHandler {
        interface: IActivateAudioInterfaceCompletionHandler,
        refs: AtomicU32,
        event: winapi::shared::ntdef::HANDLE,
        operation: *mut IActivateAudioInterfaceAsyncOperation,
    }

    unsafe extern "system" fn query_interface(
        this: *mut IUnknown,
        iid: REFIID,
        object: *mut *mut c_void,
    ) -> HRESULT {
        if object.is_null() {
            return E_POINTER;
        }
        *object = null_mut();
        if iid.is_null() {
            return E_NOINTERFACE;
        }
        if IsEqualGUID(&*iid, &IUnknown::uuidof())
            || IsEqualGUID(&*iid, &IID_IAGILE_OBJECT)
            || IsEqualGUID(&*iid, &IActivateAudioInterfaceCompletionHandler::uuidof())
        {
            *object = this as *mut c_void;
            add_ref(this);
            S_OK
        } else {
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn add_ref(this: *mut IUnknown) -> ULONG {
        let handler = this as *mut CompletionHandler;
        (*handler).refs.fetch_add(1, Ordering::Relaxed) + 1
    }

    unsafe extern "system" fn release(this: *mut IUnknown) -> ULONG {
        let handler = this as *mut CompletionHandler;
        let remaining = (*handler).refs.fetch_sub(1, Ordering::Release) - 1;
        if remaining == 0 {
            std::sync::atomic::fence(Ordering::Acquire);
            drop(Box::from_raw(handler));
        }
        remaining
    }

    unsafe extern "system" fn activate_completed(
        this: *mut IActivateAudioInterfaceCompletionHandler,
        operation: *mut IActivateAudioInterfaceAsyncOperation,
    ) -> HRESULT {
        let handler = this as *mut CompletionHandler;
        (*handler).operation = operation;
        if !operation.is_null() {
            (*operation).AddRef();
        }
        SetEvent((*handler).event);
        S_OK
    }

    static COMPLETION_VTABLE: IActivateAudioInterfaceCompletionHandlerVtbl =
        IActivateAudioInterfaceCompletionHandlerVtbl {
            parent: IUnknownVtbl {
                QueryInterface: query_interface,
                AddRef: add_ref,
                Release: release,
            },
            ActivateCompleted: activate_completed,
        };

    unsafe fn succeeded(result: HRESULT) -> bool {
        result >= 0
    }

    unsafe fn activate(root_pid: u32) -> Result<*mut IAudioClient, String> {
        let event = CreateEventW(null_mut(), TRUE, FALSE, null());
        if event.is_null() {
            return Err("CreateEventW failed for activation".to_string());
        }
        let handler = Box::into_raw(Box::new(CompletionHandler {
            interface: IActivateAudioInterfaceCompletionHandler {
                lpVtbl: &COMPLETION_VTABLE,
            },
            refs: AtomicU32::new(1),
            event,
            operation: null_mut(),
        }));

        let mut activation_params = AudioClientActivationParams {
            activation_type: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            process_loopback_params: AudioClientProcessLoopbackParams {
                target_process_id: root_pid,
                process_loopback_mode: PROCESS_LOOPBACK_INCLUDE_TARGET_PROCESS_TREE,
            },
        };
        let mut propvariant: PROPVARIANT = zeroed();
        propvariant.vt = VT_BLOB as u16;
        *propvariant.data.blob_mut() = BLOB {
            cbSize: size_of::<AudioClientActivationParams>() as ULONG,
            pBlobData: &mut activation_params as *mut _ as *mut BYTE,
        };

        let mut activation_operation = null_mut();
        let started = ActivateAudioInterfaceAsync(
            DEVICE_PATH.as_ptr(),
            &IID_IAudioClient,
            &mut propvariant,
            &mut (*handler).interface,
            &mut activation_operation,
        );
        if !succeeded(started) {
            CloseHandle(event);
            release(handler as *mut IUnknown);
            return Err(format!(
                "ActivateAudioInterfaceAsync failed with HRESULT 0x{:08X}",
                started as u32
            ));
        }
        if WaitForSingleObject(event, INFINITE) != WAIT_OBJECT_0 {
            CloseHandle(event);
            release(handler as *mut IUnknown);
            return Err("Waiting for audio activation failed".to_string());
        }

        let operation = (*handler).operation;
        if operation.is_null() {
            CloseHandle(event);
            release(handler as *mut IUnknown);
            return Err("Audio activation completed without an operation".to_string());
        }
        let mut activation_result: HRESULT = 0;
        let mut unknown: *mut IUnknown = null_mut();
        let get_result = (*operation).GetActivateResult(&mut activation_result, &mut unknown);
        (*operation).Release();
        CloseHandle(event);
        release(handler as *mut IUnknown);
        if !succeeded(get_result) || !succeeded(activation_result) || unknown.is_null() {
            return Err(format!(
                "Process-loopback activation failed with HRESULT 0x{:08X}",
                if !succeeded(get_result) {
                    get_result as u32
                } else {
                    activation_result as u32
                }
            ));
        }
        Ok(unknown as *mut IAudioClient)
    }

    pub fn run(root_pid: u32, probe: bool, sample_rate: u32, channels: u16) -> Result<(), String> {
        unsafe {
            let initialized = CoInitializeEx(null_mut(), COINIT_MULTITHREADED);
            if !succeeded(initialized) {
                return Err(format!(
                    "CoInitializeEx failed with HRESULT 0x{:08X}",
                    initialized as u32
                ));
            }

            let result = run_initialized(root_pid, probe, sample_rate, channels);
            CoUninitialize();
            result
        }
    }

    unsafe fn run_initialized(
        root_pid: u32,
        probe: bool,
        sample_rate: u32,
        channels: u16,
    ) -> Result<(), String> {
        let audio_client = activate(root_pid)?;
        let block_align = channels
            .checked_mul(16 / 8)
            .ok_or_else(|| "Audio channel count is too large".to_string())?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        let initialized = (*audio_client).Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags,
            1_000_000,
            0,
            &format,
            null(),
        );
        if !succeeded(initialized) {
            (*audio_client).Release();
            return Err(format!(
                "IAudioClient::Initialize failed with HRESULT 0x{:08X}",
                initialized as u32
            ));
        }

        let event = CreateEventW(null_mut(), FALSE, FALSE, null());
        if event.is_null() {
            (*audio_client).Release();
            return Err("CreateEventW failed for audio samples".to_string());
        }
        let set_event = (*audio_client).SetEventHandle(event);
        if !succeeded(set_event) {
            CloseHandle(event);
            (*audio_client).Release();
            return Err(format!(
                "IAudioClient::SetEventHandle failed with HRESULT 0x{:08X}",
                set_event as u32
            ));
        }

        let mut service = null_mut();
        let got_service = (*audio_client).GetService(&IID_IAudioCaptureClient, &mut service);
        if !succeeded(got_service) || service.is_null() {
            CloseHandle(event);
            (*audio_client).Release();
            return Err(format!(
                "IAudioClient::GetService failed with HRESULT 0x{:08X}",
                got_service as u32
            ));
        }
        let capture_client = service as *mut IAudioCaptureClient;
        let started = (*audio_client).Start();
        if !succeeded(started) {
            (*capture_client).Release();
            CloseHandle(event);
            (*audio_client).Release();
            return Err(format!(
                "IAudioClient::Start failed with HRESULT 0x{:08X}",
                started as u32
            ));
        }

        emit_event(
            "ready",
            "audio_ready",
            &format!(
                "Process-loopback PCM is ready ({} Hz, {} channel(s), signed 16-bit).",
                sample_rate, channels
            ),
        );
        if probe {
            (*audio_client).Stop();
            (*capture_client).Release();
            CloseHandle(event);
            (*audio_client).Release();
            return Ok(());
        }

        let stdout = io::stdout();
        let mut output = stdout.lock();
        let mut silence: Vec<u8> = Vec::new();
        let silence_frames = (sample_rate / 100).max(1) as usize;
        let mut next_silence_deadline = std::time::Instant::now();
        loop {
            let wait_result = WaitForSingleObject(event, 10);
            if wait_result == WAIT_TIMEOUT {
                // Process-loopback can stop signaling when the selected tree has
                // no active audio streams. Keep the pipe clocked at real time so
                // FFmpeg never stalls and later audio remains timestamp-aligned.
                silence.resize(pcm_byte_count(silence_frames, channels as usize), 0);
                if let Err(error) = output.write_all(&silence).and_then(|_| output.flush()) {
                    if error.kind() == io::ErrorKind::BrokenPipe {
                        return Ok(());
                    }
                    return Err(format!("Writing silent PCM failed: {error}"));
                }
                continue;
            }
            if wait_result != WAIT_OBJECT_0 {
                return Err("Waiting for process-loopback samples failed".to_string());
            }

            let mut wrote_frames = 0u32;
            loop {
                let mut packet_frames = 0;
                let packet_status = (*capture_client).GetNextPacketSize(&mut packet_frames);
                if !succeeded(packet_status) {
                    return Err(format!(
                        "GetNextPacketSize failed with HRESULT 0x{:08X}",
                        packet_status as u32
                    ));
                }
                if packet_frames == 0 {
                    break;
                }

                let mut data: *mut BYTE = null_mut();
                let mut frames = 0;
                let mut flags: DWORD = 0;
                let buffer_status = (*capture_client).GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    null_mut(),
                    null_mut(),
                );
                if !succeeded(buffer_status) {
                    return Err(format!(
                        "GetBuffer failed with HRESULT 0x{:08X}",
                        buffer_status as u32
                    ));
                }

                let byte_count = frames as usize * format.nBlockAlign as usize;
                let write_result = if flags & AUDCLNT_BUFFERFLAGS_SILENT != 0 {
                    silence.resize(byte_count, 0);
                    output.write_all(&silence)
                } else if data.is_null() {
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "WASAPI returned a null non-silent buffer",
                    ))
                } else {
                    output.write_all(slice::from_raw_parts(data, byte_count))
                };
                let released = (*capture_client).ReleaseBuffer(frames);
                if let Err(error) = write_result {
                    (*audio_client).Stop();
                    (*capture_client).Release();
                    CloseHandle(event);
                    (*audio_client).Release();
                    if error.kind() == io::ErrorKind::BrokenPipe {
                        return Ok(());
                    }
                    return Err(format!("Writing PCM failed: {error}"));
                }
                if !succeeded(released) {
                    return Err(format!(
                        "ReleaseBuffer failed with HRESULT 0x{:08X}",
                        released as u32
                    ));
                }
                output
                    .flush()
                    .map_err(|error| format!("Flushing PCM failed: {error}"))?;
                wrote_frames += frames;
            }
            if wrote_frames == 0 {
                // Some Windows versions signal an empty process-loopback event
                // continuously while the target is quiet. Pace an explicit
                // 10 ms silent packet instead of spinning or starving FFmpeg.
                next_silence_deadline += std::time::Duration::from_millis(10);
                let now = std::time::Instant::now();
                if next_silence_deadline > now {
                    std::thread::sleep(next_silence_deadline - now);
                } else {
                    next_silence_deadline = now;
                }
                silence.resize(pcm_byte_count(silence_frames, channels as usize), 0);
                if let Err(error) = output.write_all(&silence).and_then(|_| output.flush()) {
                    if error.kind() == io::ErrorKind::BrokenPipe {
                        return Ok(());
                    }
                    return Err(format!("Writing silent PCM failed: {error}"));
                }
            } else {
                next_silence_deadline += std::time::Duration::from_secs_f64(
                    wrote_frames as f64 / format.nSamplesPerSec as f64,
                );
                let now = std::time::Instant::now();
                if next_silence_deadline > now {
                    std::thread::sleep(next_silence_deadline - now);
                } else {
                    next_silence_deadline = now;
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn run(
        _root_pid: u32,
        _probe: bool,
        _sample_rate: u32,
        _channels: u16,
    ) -> Result<(), String> {
        Err("Windows process-loopback capture is only available on Windows.".to_string())
    }
}

fn main() {
    let options = match parse_args(env::args()) {
        Ok(options) => options,
        Err(error) => {
            emit_event("error", "invalid_arguments", &error);
            std::process::exit(2);
        }
    };
    if let Err(error) = platform::run(
        options.root_pid,
        options.probe,
        options.sample_rate,
        options.channels,
    ) {
        emit_event("error", "capture_failed", &error);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_args, pcm_byte_count, silent_pcm_packet, Options};

    #[test]
    fn parses_root_pid() {
        assert_eq!(
            parse_args(["helper", "--root-pid", "42"].map(str::to_string)),
            Ok(Options {
                root_pid: 42,
                probe: false,
                sample_rate: 48_000,
                channels: 2,
            })
        );
    }

    #[test]
    fn parses_probe_mode() {
        assert_eq!(
            parse_args(["helper", "--root-pid", "42", "--probe"].map(str::to_string)),
            Ok(Options {
                root_pid: 42,
                probe: true,
                sample_rate: 48_000,
                channels: 2,
            })
        );
    }

    #[test]
    fn rejects_missing_and_invalid_root_pid() {
        assert!(parse_args(["helper"].map(str::to_string)).is_err());
        assert!(parse_args(["helper", "--root-pid", "0"].map(str::to_string)).is_err());
        assert!(parse_args(["helper", "--root-pid", "game"].map(str::to_string)).is_err());
    }

    #[test]
    fn rejects_unknown_arguments() {
        assert!(parse_args(["helper", "--all-audio"].map(str::to_string)).is_err());
    }

    #[test]
    fn parses_custom_pcm_format() {
        assert_eq!(
            parse_args(
                [
                    "helper",
                    "--root-pid",
                    "42",
                    "--sample-rate",
                    "16000",
                    "--channels",
                    "1",
                ]
                .map(str::to_string),
            ),
            Ok(Options {
                root_pid: 42,
                probe: false,
                sample_rate: 16_000,
                channels: 1,
            })
        );
    }

    #[test]
    fn rejects_invalid_custom_pcm_format() {
        assert!(parse_args(
            ["helper", "--root-pid", "42", "--sample-rate", "0"].map(str::to_string)
        )
        .is_err());
        assert!(
            parse_args(["helper", "--root-pid", "42", "--channels", "0"].map(str::to_string))
                .is_err()
        );
    }

    #[test]
    fn formats_s16_silence_packets_for_requested_channels() {
        let packet = silent_pcm_packet(480, 2);
        assert_eq!(pcm_byte_count(48_000, 2), 192_000);
        assert_eq!(packet.len(), 1_920);
        assert!(packet.iter().all(|sample| *sample == 0));
        assert_eq!(silent_pcm_packet(160, 1).len(), 320);
    }
}
