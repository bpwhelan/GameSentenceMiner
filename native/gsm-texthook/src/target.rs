use serde_json::{json, Value};

#[cfg(windows)]
pub struct Target(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Target {
    pub fn open(pid: u32) -> Result<Self, String> {
        use windows::Win32::System::Threading::*;
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )
            .map(Self)
            .map_err(|e| format!("Cannot open target process {pid}: {e}"))
        }
    }
    pub fn alive(&self) -> bool {
        unsafe {
            windows::Win32::System::Threading::WaitForSingleObject(self.0, 0)
                == windows::Win32::Foundation::WAIT_TIMEOUT
        }
    }
    fn info(&self) -> Value {
        use windows::Win32::System::Threading::*;
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        let path = unsafe {
            QueryFullProcessImageNameW(
                self.0,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut len,
            )
        }
        .ok()
        .map(|_| String::from_utf16_lossy(&buffer[..len as usize]));
        use windows::Win32::System::SystemInformation::*;
        let mut process_machine = IMAGE_FILE_MACHINE_UNKNOWN;
        let mut native_machine = IMAGE_FILE_MACHINE_UNKNOWN;
        let arch =
            if unsafe { IsWow64Process2(self.0, &mut process_machine, Some(&mut native_machine)) }
                .is_ok()
            {
                match if process_machine == IMAGE_FILE_MACHINE_UNKNOWN {
                    native_machine
                } else {
                    process_machine
                } {
                    IMAGE_FILE_MACHINE_I386 => "x86",
                    IMAGE_FILE_MACHINE_AMD64 => "x64",
                    _ => "unknown",
                }
            } else {
                "unknown"
            };
        json!({"path":path,"arch":arch,"alive":self.alive()})
    }
}
#[cfg(windows)]
impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
pub struct Target {
    pid: u32,
    started: String,
}
#[cfg(not(windows))]
impl Target {
    fn identity(pid: u32) -> Result<String, String> {
        let stat =
            std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?;
        let fields = stat
            .rsplit_once(')')
            .ok_or("Invalid process metadata")?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        if fields.first() == Some(&"Z") {
            return Err("Target process has exited".into());
        }
        fields
            .get(19)
            .map(|s| s.to_string())
            .ok_or("Missing process creation time".into())
    }
    pub fn open(pid: u32) -> Result<Self, String> {
        Ok(Self {
            pid,
            started: Self::identity(pid)?,
        })
    }
    pub fn alive(&self) -> bool {
        Self::identity(self.pid).is_ok_and(|s| s == self.started)
    }
    fn info(&self) -> Value {
        json!({"alive":self.alive(),"path":std::fs::read_link(format!("/proc/{}/exe",self.pid)).ok(),"arch":"unknown"})
    }
}
pub fn process_info(pid: u32) -> Result<Value, String> {
    Ok(Target::open(pid)?.info())
}

#[cfg(windows)]
pub fn list_processes() -> Result<Value, String> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::{Diagnostics::ToolHelp::*, ProcessStatus::*, Threading::*},
    };
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut rows = vec![];
        let mut result = Process32FirstW(snapshot, &mut entry);
        while result.is_ok() {
            let name = String::from_utf16_lossy(
                &entry.szExeFile[..entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len())],
            );
            let mut memory = PROCESS_MEMORY_COUNTERS {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ..Default::default()
            };
            if let Ok(process) = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                false,
                entry.th32ProcessID,
            ) {
                let _ = GetProcessMemoryInfo(
                    process,
                    &mut memory,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                );
                let _ = CloseHandle(process);
            }
            if entry.th32ProcessID > 0 {
                rows.push(json!({"pid":entry.th32ProcessID,"ppid":entry.th32ParentProcessID,"name":name,"memory":memory.WorkingSetSize}));
            }
            result = Process32NextW(snapshot, &mut entry);
        }
        let _ = CloseHandle(snapshot);
        Ok(json!(rows))
    }
}
#[cfg(not(windows))]
pub fn list_processes() -> Result<Value, String> {
    Err("Windows process discovery is unavailable on this platform".into())
}
