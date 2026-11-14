//! Minimal bindings to the pinned frida-core C ABI. All GObjects and callbacks
//! stay on one GLib context/thread; only GCancellable crosses threads (GLib
//! explicitly supports cancelling it from another thread).
use serde_json::Value;
use std::{
    ffi::{c_char, c_int, c_ulong, c_void, CStr, CString},
    marker::PhantomData,
    ptr::null_mut,
    rc::Rc,
    sync::{Arc, Once},
};
type Ptr = *mut c_void;
#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}
extern "C" {
    fn frida_init();
    fn frida_version_string() -> *const c_char;
    fn frida_unref(p: Ptr);
    fn g_main_context_iteration(p: Ptr, may_block: c_int) -> c_int;
    fn g_object_unref(p: Ptr);
    fn g_error_free(p: *mut GError);
    fn g_cancellable_new() -> Ptr;
    fn g_cancellable_cancel(p: Ptr);
    fn g_cancellable_is_cancelled(p: Ptr) -> c_int;
    fn g_bytes_new(p: *const c_void, len: usize) -> Ptr;
    fn g_bytes_get_data(p: Ptr, len: *mut usize) -> *const u8;
    fn g_bytes_unref(p: Ptr);
    fn g_signal_connect_data(
        instance: Ptr,
        name: *const c_char,
        handler: Option<unsafe extern "C" fn()>,
        data: Ptr,
        destroy: Option<unsafe extern "C" fn(Ptr, Ptr)>,
        flags: c_int,
    ) -> c_ulong;
    fn g_signal_handler_disconnect(instance: Ptr, id: c_ulong);
    fn frida_device_manager_new() -> Ptr;
    fn frida_device_manager_close_sync(p: Ptr, cancel: Ptr, error: *mut *mut GError);
    fn frida_device_manager_get_device_by_type_sync(
        p: Ptr,
        kind: c_int,
        timeout: c_int,
        cancel: Ptr,
        error: *mut *mut GError,
    ) -> Ptr;
    fn frida_device_manager_add_remote_device_sync(
        p: Ptr,
        address: *const c_char,
        options: Ptr,
        cancel: Ptr,
        error: *mut *mut GError,
    ) -> Ptr;
    fn frida_device_enumerate_processes_sync(
        p: Ptr,
        options: Ptr,
        cancel: Ptr,
        error: *mut *mut GError,
    ) -> Ptr;
    fn frida_process_list_size(p: Ptr) -> c_int;
    fn frida_process_list_get(p: Ptr, index: c_int) -> Ptr;
    fn frida_process_get_pid(p: Ptr) -> u32;
    fn frida_process_get_name(p: Ptr) -> *const c_char;
    fn frida_device_attach_sync(
        p: Ptr,
        pid: u32,
        options: Ptr,
        cancel: Ptr,
        error: *mut *mut GError,
    ) -> Ptr;
    fn frida_session_is_detached(p: Ptr) -> c_int;
    fn frida_session_detach_sync(p: Ptr, cancel: Ptr, error: *mut *mut GError);
    fn frida_session_create_script_sync(
        p: Ptr,
        source: *const c_char,
        options: Ptr,
        cancel: Ptr,
        error: *mut *mut GError,
    ) -> Ptr;
    fn frida_script_options_new() -> Ptr;
    fn frida_script_options_set_name(p: Ptr, name: *const c_char);
    fn frida_script_options_set_runtime(p: Ptr, runtime: c_int);
    fn frida_script_load_sync(p: Ptr, cancel: Ptr, error: *mut *mut GError);
    fn frida_script_unload_sync(p: Ptr, cancel: Ptr, error: *mut *mut GError);
    fn frida_script_post(p: Ptr, json: *const c_char, data: Ptr);
}
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe { frida_init() });
}
pub fn version() -> String {
    init();
    unsafe {
        CStr::from_ptr(frida_version_string())
            .to_string_lossy()
            .into_owned()
    }
}
fn string(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "Frida string contains a NUL character".into())
}
fn result(error: *mut GError) -> Result<(), String> {
    if error.is_null() {
        Ok(())
    } else {
        unsafe {
            let message = CStr::from_ptr((*error).message)
                .to_string_lossy()
                .into_owned();
            g_error_free(error);
            Err(message)
        }
    }
}
struct Object(Ptr, PhantomData<Rc<()>>);
impl Object {
    fn new(p: Ptr, error: *mut GError) -> Result<Self, String> {
        result(error)?;
        if p.is_null() {
            Err("Frida returned an empty object".into())
        } else {
            Ok(Self(p, PhantomData))
        }
    }
}
impl Drop for Object {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { frida_unref(self.0) }
        }
    }
}
pub struct Context(Ptr, PhantomData<Rc<()>>);
impl Context {
    pub fn new() -> Self {
        init();
        Self(null_mut(), PhantomData)
    }
    pub fn tick(&self) {
        for _ in 0..128 {
            if unsafe { g_main_context_iteration(self.0, 0) } == 0 {
                break;
            }
        }
    }
}
impl Drop for Context {
    fn drop(&mut self) {}
}
pub struct Cancellation(Ptr);
// GCancellable's API is thread safe; this is the only transferable GObject.
unsafe impl Send for Cancellation {}
unsafe impl Sync for Cancellation {}
impl Cancellation {
    pub fn new() -> Arc<Self> {
        init();
        Arc::new(Self(unsafe { g_cancellable_new() }))
    }
    pub fn cancel(&self) {
        unsafe { g_cancellable_cancel(self.0) }
    }
    pub fn cancelled(&self) -> bool {
        unsafe { g_cancellable_is_cancelled(self.0) != 0 }
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        unsafe { g_object_unref(self.0) }
    }
}
pub struct Device {
    device: Object,
    manager: Object,
}
impl Device {
    pub fn open(remote: Option<&str>, cancel: &Cancellation) -> Result<Self, String> {
        let manager = Object::new(unsafe { frida_device_manager_new() }, null_mut())?;
        let mut error = null_mut();
        let device = unsafe {
            if let Some(remote) = remote {
                frida_device_manager_add_remote_device_sync(
                    manager.0,
                    string(remote)?.as_ptr(),
                    null_mut(),
                    cancel.0,
                    &mut error,
                )
            } else {
                frida_device_manager_get_device_by_type_sync(
                    manager.0, 0, 5000, cancel.0, &mut error,
                )
            }
        };
        Ok(Self {
            device: Object::new(device, error)?,
            manager,
        })
    }
    pub fn processes(&self, cancel: &Cancellation) -> Result<Vec<(u32, String)>, String> {
        unsafe {
            let mut error = null_mut();
            let p = frida_device_enumerate_processes_sync(
                self.device.0,
                null_mut(),
                cancel.0,
                &mut error,
            );
            let list = Object::new(p, error)?;
            let mut rows = vec![];
            for i in 0..frida_process_list_size(list.0) {
                let process = Object::new(frida_process_list_get(list.0, i), null_mut())?;
                rows.push((
                    frida_process_get_pid(process.0),
                    CStr::from_ptr(frida_process_get_name(process.0))
                        .to_string_lossy()
                        .into_owned(),
                ));
            }
            Ok(rows)
        }
    }
    pub fn attach(&self, pid: u32, cancel: &Cancellation) -> Result<Session, String> {
        let mut error = null_mut();
        let p = unsafe {
            frida_device_attach_sync(self.device.0, pid, null_mut(), cancel.0, &mut error)
        };
        Ok(Session(Object::new(p, error)?))
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            frida_unref(self.device.0);
            self.device.0 = null_mut();
            frida_device_manager_close_sync(self.manager.0, null_mut(), null_mut())
        }
    }
}
pub struct Session(Object);
impl Session {
    pub fn detached(&self) -> bool {
        unsafe { frida_session_is_detached(self.0 .0) != 0 }
    }
    pub fn script(
        &self,
        source: &str,
        name: &str,
        cancel: &Cancellation,
        handler: impl FnMut(Poster, Value, Option<Vec<u8>>) + 'static,
    ) -> Result<Script, String> {
        unsafe {
            let options = Object::new(frida_script_options_new(), null_mut())?;
            frida_script_options_set_name(options.0, string(name)?.as_ptr());
            frida_script_options_set_runtime(options.0, 1);
            let mut error = null_mut();
            let p = frida_session_create_script_sync(
                self.0 .0,
                string(source)?.as_ptr(),
                options.0,
                cancel.0,
                &mut error,
            );
            let object = Object::new(p, error)?;
            let mut callback = Box::new(Callback(Box::new(handler)));
            let signal = g_signal_connect_data(
                object.0,
                c"message".as_ptr(),
                Some(std::mem::transmute::<
                    unsafe extern "C" fn(Ptr, *const c_char, Ptr, Ptr),
                    unsafe extern "C" fn(),
                >(on_message)),
                (&mut *callback as *mut Callback).cast(),
                None,
                0,
            );
            Ok(Script {
                object,
                signal,
                _callback: callback,
            })
        }
    }
    pub fn detach(&self, cancel: &Cancellation) -> Result<(), String> {
        let mut error = null_mut();
        unsafe { frida_session_detach_sync(self.0 .0, cancel.0, &mut error) };
        result(error)
    }
}
type Handler = Box<dyn FnMut(Poster, Value, Option<Vec<u8>>)>;
struct Callback(Handler);
/// Valid only during a callback, or borrowed from its owning Script.
pub struct Poster<'a>(Ptr, PhantomData<&'a Script>);
impl Poster<'_> {
    pub fn post(&self, message: Value, data: Option<&[u8]>) -> Result<(), String> {
        let json = string(&message.to_string())?;
        unsafe {
            let bytes = data
                .map(|d| g_bytes_new(d.as_ptr().cast(), d.len()))
                .unwrap_or(null_mut());
            frida_script_post(self.0, json.as_ptr(), bytes);
            if !bytes.is_null() {
                g_bytes_unref(bytes)
            }
        }
        Ok(())
    }
}
unsafe extern "C" fn on_message(script: Ptr, message: *const c_char, data: Ptr, user: Ptr) {
    // Never unwind across the foreign ABI. Message/data are copied before the
    // signal returns; callers cannot retain native pointers.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if message.is_null() || user.is_null() {
            return;
        }
        let Ok(message) = serde_json::from_slice::<Value>(CStr::from_ptr(message).to_bytes())
        else {
            return;
        };
        let bytes = if data.is_null() {
            None
        } else {
            let mut size = 0;
            let p = g_bytes_get_data(data, &mut size);
            if size > 32 * 1024 * 1024 || p.is_null() {
                None
            } else {
                Some(std::slice::from_raw_parts(p, size).to_vec())
            }
        };
        ((*user.cast::<Callback>()).0)(Poster(script, PhantomData), message, bytes);
    }));
}
pub struct Script {
    object: Object,
    signal: c_ulong,
    _callback: Box<Callback>,
}
impl Script {
    pub fn load(&self, cancel: &Cancellation) -> Result<(), String> {
        let mut error = null_mut();
        unsafe { frida_script_load_sync(self.object.0, cancel.0, &mut error) };
        result(error)
    }
    pub fn unload(&self, cancel: &Cancellation) -> Result<(), String> {
        let mut error = null_mut();
        unsafe { frida_script_unload_sync(self.object.0, cancel.0, &mut error) };
        result(error)
    }
    pub fn post(&self, message: Value) -> Result<(), String> {
        Poster(self.object.0, PhantomData).post(message, None)
    }
}
impl Drop for Script {
    fn drop(&mut self) {
        unsafe { g_signal_handler_disconnect(self.object.0, self.signal) }
    }
}
