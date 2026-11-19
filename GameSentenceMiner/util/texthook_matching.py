from __future__ import annotations

import asyncio
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum
from functools import lru_cache
from typing import Any

import regex
from rapidfuzz import process
from rapidfuzz.distance import Levenshtein

from GameSentenceMiner.util.config.configuration import TextProcessing, get_config
from GameSentenceMiner.util.language_filter import LANGUAGE_FILTER_MODES
from GameSentenceMiner.util.text_processing import (
    apply_text_processing,
    processor_states,
    run_text_processor,
    with_processor_overrides,
)

RANK_HOOKS_TOPIC = "texthook.rank"
MAX_PROCESSING_VARIANTS = 256
_SPEAKER_LABEL = regex.compile(r'^【[^】]{1,24}】(?=[「『“"])')
_FUZZY_PUNCTUATION = regex.compile(r"\A[\p{P}\s~]+|[\p{P}\s~]+\Z|[\p{P}\s]+")


class Tier(IntEnum):
    UNMATCHED = 0
    CLOSE = 1
    FILTERED = 2
    FUZZY = 3
    EXACT = 4


MatchScore = tuple[Tier, float, int]
ProcessorOverrides = dict[str, bool | str]
FilterChoices = tuple[tuple[int, int], ...]
FilterPriority = tuple[int, int, FilterChoices]


def _relaxed_text(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text.replace("〜", "~").replace("⋯", "…")).casefold()
    return _FUZZY_PUNCTUATION.sub("", folded)


@dataclass(frozen=True)
class ComparisonText:
    strict: str
    relaxed: tuple[str, ...]

    @classmethod
    def from_text(cls, text: str) -> ComparisonText:
        # OCR line wrapping and spacing vary independently of the hook output.
        strict = "".join(unicodedata.normalize("NFC", text).split())
        forms = (_relaxed_text(strict),)
        if speaker := _SPEAKER_LABEL.match(strict):
            # OCR can report the nameplate and its quote as separate blocks.
            forms += (_relaxed_text(strict[speaker.end() :]),)
        return cls(strict, forms)


@dataclass(frozen=True)
class Match:
    tier: Tier
    similarity: float
    length: int
    sample: str
    output: str
    block: str

    @property
    def score(self) -> MatchScore:
        return self.tier, self.similarity, self.length


def _best_match(
    samples: list[str],
    closest_block: Callable[[str], tuple[MatchScore, str] | None],
    config: TextProcessing,
    language: str,
) -> Match | None:
    best = None
    for sample in reversed(samples):
        output = apply_text_processing(sample, config, target_language=language)
        comparison = closest_block(output)
        if comparison is None:
            continue
        score, block = comparison
        if best is None or score > best.score:
            best = Match(*score, sample, output, block)
    return best


@dataclass(frozen=True)
class _FilterOption:
    config: TextProcessing | None
    changes: ProcessorOverrides


def _filter_options(config: TextProcessing, processor: str, enabled: bool) -> list[_FilterOption]:
    if enabled:
        return [_FilterOption(config, {})]

    changes: ProcessorOverrides = {processor: True}
    options = [
        _FilterOption(None, {}),
        _FilterOption(with_processor_overrides(config, changes), changes),
    ]
    if processor == "language_filter":
        for mode in LANGUAGE_FILTER_MODES:
            if mode != config.language_filter_config.mode:
                changes = {processor: True, "language_filter_mode": mode}
                options.append(_FilterOption(with_processor_overrides(config, changes), changes))
    return options


class _FilterSearch:
    def __init__(self, config: TextProcessing, language: str):
        states = processor_states(config)
        self.processors = list(states)
        self.options = [_filter_options(config, name, states[name]) for name in self.processors]
        index = {name: position for position, name in enumerate(self.processors)}
        self.order = [index[name] for name in config.processor_order if name in index]
        self.repeated = {position for position, count in Counter(self.order).items() if count > 1}
        self.language = language

    def outputs(self, sample: str) -> dict[tuple[str, FilterChoices], FilterPriority]:
        # Identical intermediate text can use the cheaper path. Keep a processor's
        # earlier choice in the key if a user configured that processor twice.
        variants: dict[tuple[str, FilterChoices], FilterPriority] = {(sample, ()): (0, 0, ())}
        seen = set()
        for position in self.order:
            processor = self.processors[position]
            options = self.options[position]
            outputs = {}
            for (text, repeated_choices), priority in variants.items():
                choices = (dict(repeated_choices).get(position, 0),) if position in seen else range(len(options))
                for choice in choices:
                    option = options[choice]
                    output = (
                        run_text_processor(text, processor, option.config, target_language=self.language)
                        if option.config is not None
                        else text
                    )
                    if not output:
                        continue
                    next_priority = priority
                    next_repeated = repeated_choices
                    if choice and position not in seen:
                        applied = (position, choice)
                        count, edits, path = priority
                        next_priority = (count + 1, edits + len(option.changes), (*path, applied))
                        if position in self.repeated:
                            next_repeated = (*repeated_choices, applied)
                    key = (output, next_repeated)
                    if key not in outputs or next_priority < outputs[key]:
                        outputs[key] = next_priority
            if len(outputs) > MAX_PROCESSING_VARIANTS:
                # Keep smaller changes first. The cap leaves room for every pair.
                outputs = dict(sorted(outputs.items(), key=lambda item: item[1])[:MAX_PROCESSING_VARIANTS])
            variants = outputs
            seen.add(position)
        return variants

    def changes(self, choices: FilterChoices) -> ProcessorOverrides:
        return {
            key: value for position, choice in choices for key, value in self.options[position][choice].changes.items()
        }


def _best_filtered_match(
    samples: list[str],
    closest_block: Callable[[str], tuple[MatchScore, str] | None],
    search: _FilterSearch,
) -> tuple[Match | None, ProcessorOverrides]:
    best: tuple[Match, FilterPriority] | None = None
    for sample in reversed(samples):
        for (output, _), priority in search.outputs(sample).items():
            if not priority[0] or (comparison := closest_block(output)) is None:
                continue
            score, block = comparison
            if score[0] < Tier.FUZZY:
                continue
            if best is None or score > best[0].score or (score == best[0].score and priority < best[1]):
                best = Match(*score, sample, output, block), priority
    return (best[0], search.changes(best[1][2])) if best else (None, {})


def rank_hooks(
    hooks: list[dict[str, Any]],
    blocks: list[str],
    config: TextProcessing,
    language: str,
    *,
    selected_hook_id: str | None = None,
    processor_overrides: ProcessorOverrides | None = None,
) -> list[dict[str, Any]]:
    strict_blocks: dict[str, str] = {}
    relaxed_blocks: dict[str, str] = {}
    for text in blocks:
        block = ComparisonText.from_text(text)
        if block.strict:
            strict_blocks.setdefault(block.strict, text)
            for form in block.relaxed:
                if form:
                    relaxed_blocks.setdefault(form, text)
    # RapidFuzz keeps the first choice on a tie, so prefer longer evidence.
    fuzzy_choices = sorted((form for form in relaxed_blocks if len(form) >= 4), key=len, reverse=True)

    @lru_cache(maxsize=4096)
    def closest_relaxed(form: str) -> tuple[MatchScore, str] | None:
        if form in relaxed_blocks:
            return (Tier.FUZZY, 1.0, len(form)), relaxed_blocks[form]
        if len(form) < 4:
            return None
        match = process.extractOne(form, fuzzy_choices, scorer=Levenshtein.normalized_similarity, score_cutoff=0.55)
        if match is None:
            return None
        matched, similarity, _ = match
        tier = Tier.FUZZY if similarity >= 0.86 else Tier.CLOSE
        return (tier, similarity, min(len(form), len(matched))), relaxed_blocks[matched]

    # Most filter toggles leave any given sample identical.
    @lru_cache(maxsize=4096)
    def closest_block(text: str) -> tuple[MatchScore, str] | None:
        candidate = ComparisonText.from_text(text)
        if candidate.strict in strict_blocks:
            return (Tier.EXACT, 1.0, len(candidate.relaxed[0])), strict_blocks[candidate.strict]
        best = None
        for form in candidate.relaxed:
            comparison = closest_relaxed(form)
            if comparison is not None and (best is None or comparison[0] > best[0]):
                best = comparison
        return best

    selected_overrides = processor_overrides or {}
    selected_config = with_processor_overrides(config, selected_overrides)
    searches: dict[bool, _FilterSearch] = {}
    ranked = []
    for hook in hooks:
        hook_id = hook["id"]
        selected = hook_id == selected_hook_id
        active_config = selected_config if selected else config
        overrides = selected_overrides if selected else {}
        samples = hook["samples"]
        best = _best_match(samples, closest_block, active_config, language)
        change = {}
        if samples and strict_blocks and (best is None or best.tier < Tier.FUZZY):
            if selected not in searches:
                searches[selected] = _FilterSearch(active_config, language)
            filtered, change = _best_filtered_match(samples, closest_block, searches[selected])
            if filtered is not None:
                best = filtered
                overrides = overrides | change

        tier = Tier.FILTERED if change else best.tier if best else Tier.UNMATCHED
        result = {"hookId": hook_id, "tier": tier.name.lower(), "processorOverrides": overrides}
        if best is not None:
            result.update(sample=best.sample, output=best.output, ocrText=best.block)
        if change:
            result["changes"] = change
        ranked.append(((tier, best.similarity, best.length) if best else (tier, 0.0, 0), result))
    return [result for _, result in sorted(ranked, key=lambda item: item[0], reverse=True)]


async def handle_rank_hooks(message: dict[str, Any]) -> list[dict[str, Any]]:
    data = message["data"]
    config = get_config()
    return await asyncio.to_thread(
        rank_hooks,
        data["hooks"],
        data["blocks"],
        config.text_processing,
        config.general.target_language,
        selected_hook_id=data.get("selectedHookId"),
        processor_overrides=data.get("processorOverrides"),
    )
