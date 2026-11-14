//! Native LunaHook and Textractor sessions. No JavaScript runtime is involved in
//! launching the engines, decoding output, choosing hooks or delivering text.
mod protocol;
mod runtime;
mod target;
pub use runtime::Controller;
pub use target::{list_processes, process_info};

#[cfg(test)]
mod tests;
