//! Every kill targets an owned handle/group. No process-name scans or persisted
//! bare PIDs. On Windows the child starts suspended until its job is assigned,
//! so even workers created immediately are covered by kill-on-job-close.
use serde_json::Value;
use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
};

pub struct OwnedChild {
    pub child: Child,
    terminated: bool,
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    group: i32,
}
impl OwnedChild {
    pub fn owns_pid(&self, pid: u32) -> bool {
        if pid == self.child.id() {
            return true;
        }
        // Windows venv launchers start the interpreter as a child. Authenticate
        // that interpreter against the owned job, rather than trusting a name.
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{
                    JobObjects::IsProcessInJob,
                    Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
                },
            };
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut owned = 0;
            let queried = IsProcessInJob(process, self.job as _, &mut owned);
            CloseHandle(process);
            queried != 0 && owned != 0
        }
        #[cfg(unix)]
        unsafe {
            libc::getpgid(pid as i32) == self.group
        }
    }
    pub fn spawn(spec: &Value, env: HashMap<String, String>) -> Result<Self, String> {
        let mut command = Command::new(
            spec["command"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing process executable")?,
        );
        for arg in spec["args"].as_array().into_iter().flatten() {
            command.arg(arg.as_str().ok_or("Invalid process argument")?);
        }
        command
            .env_clear()
            .envs(env)
            .stdin(if spec["stdin"] == true {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = spec["cwd"].as_str() {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::{io::AsRawHandle, process::CommandExt};
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::*},
            };
            #[link(name = "ntdll")]
            extern "system" {
                fn NtResumeProcess(process: *mut std::ffi::c_void) -> i32;
            }
            let priority = match spec["priority"].as_str().unwrap_or("normal") {
                "low" => IDLE_PRIORITY_CLASS,
                "below_normal" => BELOW_NORMAL_PRIORITY_CLASS,
                "above_normal" => ABOVE_NORMAL_PRIORITY_CLASS,
                "high" => HIGH_PRIORITY_CLASS,
                _ => NORMAL_PRIORITY_CLASS,
            };
            let flags = CREATE_SUSPENDED
                | priority
                | if spec["windowsHide"] == false {
                    0
                } else {
                    CREATE_NO_WINDOW
                };
            command.creation_flags(flags);
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut child = match command.spawn() {
                    Ok(child) => child,
                    Err(error) => {
                        CloseHandle(job);
                        return Err(error.to_string());
                    }
                };
                if AssignProcessToJobObject(job, child.as_raw_handle()) == 0
                    || NtResumeProcess(child.as_raw_handle()) < 0
                {
                    let error = std::io::Error::last_os_error().to_string();
                    let _ = child.kill();
                    let _ = child.wait();
                    CloseHandle(job);
                    return Err(format!("Could not own Python process tree: {error}"));
                }
                Ok(Self {
                    child,
                    job: job as usize,
                    terminated: false,
                })
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            let child = command.spawn().map_err(|e| e.to_string())?;
            let group = child.id() as i32;
            Ok(Self {
                child,
                group,
                terminated: false,
            })
        }
    }
    pub fn terminate(&mut self) -> Result<(), String> {
        if self.terminated {
            return Ok(());
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            if TerminateJobObject(self.job as _, 1) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(unix)]
        {
            // Darwin can still find the group while its last child is exiting,
            // yet find no live member to signal. Reap it and retry the group so
            // descendants are still accounted for and real permission errors surface.
            #[cfg(target_os = "macos")]
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
            loop {
                if unsafe { libc::kill(-self.group, libc::SIGKILL) } == 0 { break; }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) { break; }
                #[cfg(target_os = "macos")]
                if error.raw_os_error() == Some(libc::EPERM) && std::time::Instant::now() < deadline {
                    self.child.try_wait().map_err(|error| error.to_string())?;
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
                return Err(format!("Could not terminate owned process group {}: {error}", self.group));
            }
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.job as _,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                if info.ActiveProcesses == 0 {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("Python worker cleanup timed out".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        self.child.wait().map_err(|e| e.to_string())?;
        self.terminated = true;
        Ok(())
    }

    pub fn set_priority(&self, priority: &str) -> Result<(), String> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::{JobObjects::*, Threading::*};
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
            limits.BasicLimitInformation.PriorityClass = match priority {
                "low" => IDLE_PRIORITY_CLASS,
                "below_normal" => BELOW_NORMAL_PRIORITY_CLASS,
                "above_normal" => ABOVE_NORMAL_PRIORITY_CLASS,
                "high" => HIGH_PRIORITY_CLASS,
                _ => NORMAL_PRIORITY_CLASS,
            };
            if SetInformationJobObject(
                self.job as _,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(not(windows))]
        let _ = priority;
        Ok(())
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.terminate();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
    }
}
