//! Overlay computation independent of Python, Node and the window system.
pub mod adaptive;
pub mod correction;
pub mod engines;
mod inference;
pub mod layout;
pub mod models;
pub mod ocr;
mod overlay_filter;
pub mod pipeline;
pub mod presence;
pub mod scheduling;
pub mod text_filter;
pub mod text_matching;
pub mod timing;
