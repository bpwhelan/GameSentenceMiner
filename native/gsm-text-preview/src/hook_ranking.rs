//! Compare one discovery snapshot with independently recognized OCR blocks.
//! All working state belongs to the batch, including the suggested-filter search.
mod comparison;

use super::language::Target;
use super::{language_mode, processor_enabled, processor_order, Processors, DEFAULTS};
use comparison::{Blocks, Hit, Tier};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

const MAX_VARIANTS: usize = 256;
type Choices = Vec<(usize, usize)>;

/// Active only during discovery. Check the profile when a frame has text,
/// retaining just the processing section between frames.
pub struct HookFinder {
    profile_dir: PathBuf,
    profile: Option<TextProfile>,
}

struct TextProfile {
    revision: Option<(SystemTime, u64)>,
    config: Value,
    target: Target,
}

impl HookFinder {
    pub fn new(profile_dir: PathBuf) -> Self {
        Self {
            profile_dir,
            profile: None,
        }
    }

    pub fn rank(
        &mut self,
        snapshot: &Value,
        blocks: &[String],
        cancelled: impl Fn() -> bool,
    ) -> Result<Value, String> {
        let metadata = std::fs::metadata(self.profile_dir.join("config.json"));
        let stamp = metadata
            .ok()
            .and_then(|m| Some((m.modified().ok()?, m.len())));
        let profile = match &mut self.profile {
            Some(cached) if stamp.is_some() && cached.revision == stamp => cached,
            slot => {
                let (config, language) = gsm_settings::workspace::Workspace::new(&self.profile_dir)
                    .text_and_language()?;
                slot.insert(TextProfile {
                    revision: stamp,
                    config,
                    target: Target::new(&language),
                })
            }
        };
        rank_hooks(
            snapshot,
            blocks,
            &profile.config,
            &profile.target,
            cancelled,
        )
    }
}

// Fewest additional filters, then fewest setting edits, then saved pipeline order.
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
struct Cost {
    filters: usize,
    edits: usize,
    choices: Choices,
}

struct Step<'a> {
    name: &'a str,
    enabled: bool,
    repeated: bool,
    // For the language filter, choice 1 keeps the configured mode.
    alternate_modes: Vec<&'static str>,
}

struct Pipeline<'a> {
    mode: &'a str,
    steps: Vec<Step<'a>>,
    order: Vec<usize>,
}

impl<'a> Pipeline<'a> {
    fn new(config: &'a Value, overrides: &'a Value) -> Result<Self, String> {
        let mode = overrides["language_filter_mode"]
            .as_str()
            .filter(|m| matches!(*m, "blocks" | "trim" | "strict"))
            .unwrap_or_else(|| language_mode(config));
        let mut steps: Vec<Step> = Vec::new();
        let mut order = Vec::new();
        for name in processor_order(config)? {
            if !DEFAULTS["processor_order"]
                .as_array()
                .unwrap()
                .iter()
                .any(|known| known == name)
            {
                continue;
            }
            let position = if let Some(index) = steps.iter().position(|s| s.name == name) {
                steps[index].repeated = true;
                index
            } else {
                let enabled = overrides[name]
                    .as_bool()
                    .unwrap_or_else(|| processor_enabled(config, name));
                let alternate_modes = if !enabled && name == "language_filter" {
                    ["blocks", "trim", "strict"]
                        .into_iter()
                        .filter(|&other| other != mode)
                        .collect()
                } else {
                    Vec::new()
                };
                steps.push(Step {
                    name,
                    enabled,
                    repeated: false,
                    alternate_modes,
                });
                steps.len() - 1
            };
            order.push(position);
        }
        Ok(Self { mode, steps, order })
    }

    fn apply(
        &self,
        text: String,
        step: &Step,
        choice: usize,
        batch: &Batch,
    ) -> Result<String, String> {
        if !step.enabled && choice == 0 {
            return Ok(text);
        }
        let mode = if choice < 2 {
            self.mode
        } else {
            step.alternate_modes[choice - 2]
        };
        batch.processors.apply(text, step.name, mode)
    }

    fn process(&self, sample: &str, batch: &Batch) -> Result<String, String> {
        let mut text = sample.to_owned();
        for &position in &self.order {
            if text.is_empty() {
                break;
            }
            text = self.apply(text, &self.steps[position], 0, batch)?;
        }
        Ok(text)
    }

    fn variants(
        &self,
        sample: &str,
        batch: &Batch,
    ) -> Result<IndexMap<(String, Choices), Cost>, String> {
        let mut variants = IndexMap::from([((sample.to_owned(), Vec::new()), Cost::default())]);
        let mut seen = vec![false; self.steps.len()];
        for &position in &self.order {
            let step = &self.steps[position];
            let mut outputs = IndexMap::new();
            let mut bytes = 0;
            for ((text, previous), cost) in variants {
                batch.check()?;
                let choices = if seen[position] {
                    let choice = previous
                        .iter()
                        .find(|(p, _)| *p == position)
                        .map_or(0, |&(_, c)| c);
                    choice..choice + 1
                } else if step.enabled {
                    0..1
                } else {
                    0..2 + step.alternate_modes.len()
                };
                for choice in choices {
                    let output = self.apply(text.clone(), step, choice, batch)?;
                    if output.is_empty() {
                        continue;
                    }
                    let mut next = cost.clone();
                    let mut repeated = previous.clone();
                    if choice != 0 && !seen[position] {
                        next.filters += 1;
                        next.edits += if choice == 1 { 1 } else { 2 };
                        next.choices.push((position, choice));
                        if step.repeated {
                            repeated.push((position, choice));
                        }
                    }
                    let size = output.len();
                    let entry = outputs.entry((output, repeated));
                    match entry {
                        indexmap::map::Entry::Vacant(entry) => {
                            bytes += size;
                            if bytes > 16 * 1024 * 1024 {
                                return Err(
                                    "Hook comparison filter outputs exceed the size limit.".into(),
                                );
                            }
                            entry.insert(next);
                        }
                        indexmap::map::Entry::Occupied(mut entry) if next < *entry.get() => {
                            entry.insert(next);
                        }
                        _ => {}
                    }
                }
            }
            if outputs.len() > MAX_VARIANTS {
                outputs.sort_by(|_, a, _, b| a.cmp(b));
                outputs.truncate(MAX_VARIANTS);
            }
            variants = outputs;
            seen[position] = true;
        }
        Ok(variants)
    }

    fn changes(&self, choices: &Choices) -> Value {
        let mut changes = json!({});
        for &(position, choice) in choices {
            let step = &self.steps[position];
            changes[step.name] = Value::Bool(true);
            if choice > 1 {
                changes["language_filter_mode"] = json!(step.alternate_modes[choice - 2]);
            }
        }
        changes
    }
}

struct Batch<'a> {
    processors: Processors<'a>,
    cancelled: &'a dyn Fn() -> bool,
}

impl Batch<'_> {
    fn check(&self) -> Result<(), String> {
        if (self.cancelled)() {
            Err("Hook comparison cancelled.".into())
        } else if Instant::now() >= self.processors.deadline {
            Err("Hook comparison timed out.".into())
        } else {
            Ok(())
        }
    }
}

struct Evidence<'a> {
    sample: &'a str,
    output: String,
    hit: Hit,
    cost: Cost,
}

fn best_match<'a>(
    samples: &[&'a str],
    pipeline: &Pipeline,
    blocks: &mut Blocks,
    batch: &Batch,
) -> Result<Option<Evidence<'a>>, String> {
    let mut best: Option<Evidence> = None;
    if blocks.is_empty() {
        return Ok(None);
    }
    for &sample in samples.iter().rev() {
        batch.check()?;
        let output = pipeline.process(sample, batch)?;
        if let Some(hit) = blocks.closest(&output, batch)? {
            if best.as_ref().is_none_or(|prev| hit.score > prev.hit.score) {
                best = Some(Evidence {
                    sample,
                    output,
                    hit,
                    cost: Cost::default(),
                });
            }
        }
    }
    if best
        .as_ref()
        .is_some_and(|prev| prev.hit.score.0 >= Tier::Fuzzy)
    {
        return Ok(best);
    }
    for &sample in samples.iter().rev() {
        for ((output, _), cost) in pipeline.variants(sample, batch)? {
            if cost.filters == 0 {
                continue;
            }
            let Some(hit) = blocks.closest(&output, batch)? else {
                continue;
            };
            if hit.score.0 >= Tier::Fuzzy
                && best.as_ref().is_none_or(|prev| {
                    hit.score > prev.hit.score || (hit.score == prev.hit.score && cost < prev.cost)
                })
            {
                best = Some(Evidence {
                    sample,
                    output,
                    hit,
                    cost,
                });
            }
        }
    }
    Ok(best)
}

fn rank_hooks(
    snapshot: &Value,
    text_blocks: &[String],
    config: &Value,
    target: &Target,
    cancelled: impl Fn() -> bool,
) -> Result<Value, String> {
    let batch = Batch {
        processors: Processors::new(config, target, Instant::now() + Duration::from_secs(15)),
        cancelled: &cancelled,
    };
    batch.check()?;
    let hooks = snapshot["hooks"]
        .as_array()
        .ok_or("Hook discovery requires a list of hooks.")?;
    let base = Pipeline::new(config, &Value::Null)?;
    let overrides = &snapshot["processorOverrides"];
    let selected_pipeline = if snapshot["selectedHookId"].is_string() {
        Some(Pipeline::new(config, overrides)?)
    } else {
        None
    };
    let mut blocks = Blocks::new(text_blocks, &batch)?;
    let mut ranked = Vec::with_capacity(hooks.len());
    for hook in hooks {
        batch.check()?;
        let id = hook["id"].as_str().ok_or("Missing hook ID.")?;
        let selected = snapshot["selectedHookId"] == id;
        let pipeline = selected_pipeline
            .as_ref()
            .filter(|_| selected)
            .unwrap_or(&base);
        let samples: Vec<_> = hook["samples"]
            .as_array()
            .ok_or("Missing hook samples.")?
            .iter()
            .map(|s| s.as_str().ok_or("Invalid hook sample."))
            .collect::<Result<_, _>>()?;
        let mut effective = if selected && overrides.is_object() {
            overrides.clone()
        } else {
            json!({})
        };
        let mut result = json!({"hookId":id});
        let mut score = (Tier::Unmatched, 0.0, 0);
        if let Some(best) = best_match(&samples, pipeline, &mut blocks, &batch)? {
            score = best.hit.score;
            result["sample"] = json!(best.sample);
            result["output"] = Value::String(best.output);
            result["ocrText"] = json!(text_blocks[best.hit.block]);
            if best.cost.filters != 0 {
                score.0 = Tier::Filtered;
                let changes = pipeline.changes(&best.cost.choices);
                effective
                    .as_object_mut()
                    .unwrap()
                    .extend(changes.as_object().unwrap().clone());
                result["changes"] = changes;
            }
        }
        result["tier"] = json!(score.0.name());
        result["processorOverrides"] = effective;
        ranked.push((score, result));
    }
    ranked.sort_by(|(a, _), (b, _)| b.partial_cmp(a).unwrap());
    batch.check()?;
    Ok(Value::Array(
        ranked.into_iter().map(|(_, result)| result).collect(),
    ))
}
