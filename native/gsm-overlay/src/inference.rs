//! Explicit CPU inference shared by OCR and speech models. Native inference
//! never probes a GPU, loads CUDA libraries or consults old device preferences.
use crate::scheduling::ThreadPolicy;
use anyhow::Result;
use ort::{
    environment::ThreadManager,
    ep::CPU,
    session::{
        Session,
        builder::{GraphOptimizationLevel, SessionBuilder},
    },
};
use std::{path::Path, thread::JoinHandle};

struct PolicyThreadManager {
    policy: ThreadPolicy,
    name: &'static str,
}

impl ThreadManager for PolicyThreadManager {
    type Thread = JoinHandle<()>;

    fn create(&self, work: impl FnOnce() + Send + 'static) -> ort::Result<Self::Thread> {
        let policy = self.policy.clone();
        std::thread::Builder::new()
            .name(self.name.into())
            .spawn(move || {
                policy.apply_to_current_thread();
                work();
            })
            .map_err(|error| ort::Error::new(format!("Spawn ONNX worker thread: {error}")))
    }

    fn join(thread: Self::Thread) -> ort::Result<()> {
        let _ = thread.join();
        Ok(())
    }
}

fn builder(
    threads: usize,
    memory_pattern: bool,
    policy: &ThreadPolicy,
) -> ort::Result<SessionBuilder> {
    let mut builder = Session::builder()?
        .with_no_environment_execution_providers()?
        .with_execution_providers([CPU::default()
            .with_arena_allocator(true)
            .build()
            .error_on_failure()])?
        .with_intra_threads(threads)?
        .with_inter_threads(1)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?
        .with_memory_pattern(memory_pattern)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?;
    if threads > 1 && policy.needs_custom_thread_manager() {
        builder = builder.with_thread_manager(PolicyThreadManager {
            policy: policy.clone(),
            name: "gsm-ort-ocr",
        })?;
    }
    Ok(builder)
}

pub struct Model(Session);
impl Model {
    pub fn file(path: &Path, threads: usize) -> Result<Self> {
        Self::file_with_pattern(path, threads, true)
    }
    pub fn file_with_pattern(path: &Path, threads: usize, memory_pattern: bool) -> Result<Self> {
        Self::file_with_policy(path, threads, memory_pattern, &ThreadPolicy::default())
    }
    pub fn file_with_policy(
        path: &Path,
        default_threads: usize,
        memory_pattern: bool,
        policy: &ThreadPolicy,
    ) -> Result<Self> {
        let threads = policy.resolve_onnx_threads(default_threads);
        Ok(Self(
            builder(threads, memory_pattern, policy)?.commit_from_file(path)?,
        ))
    }
    pub fn infer<T>(&mut self, run: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        run(&mut self.0)
    }
}
