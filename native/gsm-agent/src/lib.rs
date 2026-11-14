pub const FRIDA_VERSION: &str = "17.16.4";
mod controller;
#[cfg_attr(not(feature = "runtime"), allow(dead_code))]
mod core;
pub mod host;
pub use controller::Controller;
#[cfg(feature = "runtime")]
pub mod frida;
#[cfg(feature = "runtime")]
pub use frida::version;
#[cfg(feature = "runtime")]
mod runtime;
#[cfg(feature = "runtime")]
mod server;
#[cfg(feature = "runtime")]
mod wine;
#[cfg(feature = "runtime")]
pub use runtime::Runtime;

pub mod wine_bridge;
