//! Explicit CPU inference shared by OCR and speech models. Native inference
//! never probes a GPU, loads CUDA libraries or consults old device preferences.
use anyhow::Result;
use ort::{
    ep::CPU,
    session::{
        Session,
        builder::{GraphOptimizationLevel, SessionBuilder},
    },
};
use std::path::Path;

fn builder(threads: usize) -> ort::Result<SessionBuilder> {
    Ok(Session::builder()?
        .with_no_environment_execution_providers()?
        .with_execution_providers([CPU::default()
            .with_arena_allocator(true)
            .build()
            .error_on_failure()])?
        .with_intra_threads(threads)?
        .with_inter_threads(1)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?)
}

pub struct Model(Session);
impl Model {
    pub fn file(path: &Path, threads: usize) -> Result<Self> {
        Ok(Self(builder(threads)?.commit_from_file(path)?))
    }
    pub fn infer<T>(&mut self, run: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        run(&mut self.0)
    }
}
