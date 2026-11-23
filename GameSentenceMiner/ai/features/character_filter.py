from __future__ import annotations

import re
from dataclasses import dataclass

from GameSentenceMiner.ai.translation_cache import normalize_translation_source

_EAST_ASIAN = re.compile("[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\U00020000-\U0002fa1f]")


def _name_key(name: str) -> str:
    parts = name.strip(" \t\r\n*-•").lower().split()
    return ("" if _EAST_ASIAN.search(name) else " ").join(parts)


def _name_forms(names: list[str], aliases: list[str]) -> tuple[set[str], set[str]]:
    explicit = {_name_key(name) for name in (*names, *aliases)} - {""}
    parts = set()
    for name in names:
        words = name.strip(" \t*-•").split()
        if len(words) > 1:
            parts.update([_name_key(words[0]), _name_key(words[-1])])
    return explicit, parts - {""}


def _forms_for_line(line: str) -> tuple[set[str], set[str]]:
    header, separator, _ = line.replace("：", ":", 1).partition(":")
    if not separator:
        original, arrow, romanized = line.partition(" -> ")
        if not arrow:
            return set(), set()
        return _name_forms([original, re.split(r"[(（]", romanized, maxsplit=1)[0]], [])
    header = header.strip(" \t*-•")
    if header.lower() == "character list":
        return set(), set()
    return _name_forms([name.strip().rstrip(")）") for name in re.split(r"[(（]", header)], [])


@dataclass(frozen=True)
class CharacterContext:
    summary: str
    names: tuple[tuple[str, set[str], set[str]], ...] = ()

    @classmethod
    def from_metadata(cls, summary: str, data: dict | None) -> CharacterContext:
        cast = data.get("characters") if isinstance(data, dict) else None
        if isinstance(cast, dict):
            cast = [entry for group in cast.values() if isinstance(group, list) for entry in group]
        groups: dict[str, tuple[set[str], set[str]]] = {}
        for entry in cast if isinstance(cast, list) else []:
            if not isinstance(entry, dict):
                continue
            aliases = entry.get("aliases")
            names = [name for name in (entry.get("name_original"), entry.get("name")) if isinstance(name, str)]
            choices = []
            if isinstance(aliases, list):
                choices.extend(alias.get("name") if isinstance(alias, dict) else alias for alias in aliases)
            choices = [alias for alias in choices if isinstance(alias, str)]
            identity = next((key for name in names + choices if (key := _name_key(name))), None)
            if identity:
                explicit, parts = _name_forms(names, choices)
                known, known_parts = groups.setdefault(identity, (set(), set()))
                known.update(explicit)
                known_parts.update(parts)
        return cls(summary, tuple((identity, explicit, parts) for identity, (explicit, parts) in groups.items()))

    def relevant_to(self, sentence: str, dialogue: str) -> str:
        entries = []
        for line in self.summary.splitlines():
            forms, parts = _forms_for_line(line)
            if not forms:
                continue
            matches = [(identity, known, known_parts) for identity, known, known_parts in self.names if forms & known]
            if len(matches) == 1:
                identity, known, known_parts = matches[0]
                forms |= known
                parts = known_parts
            else:
                identity = min(forms)
            entries.append((line, identity, forms, parts))
        owners: dict[str, set[str]] = {}
        full_names = set()
        for identity, forms, parts in (*self.names, *(entry[1:] for entry in entries)):
            full_names.update(forms)
            for name in forms | parts:
                owners.setdefault(name, set()).add(identity)
        normalized = normalize_translation_source(f"{sentence}\n{dialogue}")
        source = "\n".join(" ".join(line.lower().split()) for line in normalized.splitlines())
        compact = ["".join(line.split()) for line in source.splitlines()]

        def word_char(char: str) -> bool:
            return bool(char and not _EAST_ASIAN.fullmatch(char) and (char.isalnum() or char == "_"))

        def appears(name: str, explicit: bool) -> bool:
            if _EAST_ASIAN.search(name):
                return any(
                    explicit or _standalone_name_part(line, match.start(), name, full_names)
                    for line in compact
                    for match in re.finditer(re.escape(name), line)
                )
            return any(
                not word_char(source[match.start() - 1 : match.start()])
                and not word_char(source[match.end() : match.end() + 1])
                and (explicit or not _inside_full_name(source, match.start(), name, full_names))
                for match in re.finditer(re.escape(name), source)
            )

        return "\n".join(
            line
            for line, identity, forms, parts in entries
            if any(owners[name] == {identity} and appears(name, name in forms) for name in forms | parts)
        )


def _standalone_name_part(text: str, start: int, name: str, full_names: set[str]) -> bool:
    if _inside_full_name(text, start, name, full_names):
        return False
    suffix = text[start + len(name) :]
    # One-character names need a delimiter, particle, or honorific to reduce ordinary-word matches.
    return (
        len(name) > 1
        or suffix.startswith(("さん", "ちゃん", "くん", "さま", "先輩", "様", "君"))
        or (
            not _EAST_ASIAN.fullmatch(text[max(0, start - 1) : start])
            and (not _EAST_ASIAN.fullmatch(suffix[:1]) or suffix.startswith(tuple("はがをにとのもへで")))
        )
    )


def _inside_full_name(text: str, start: int, name: str, full_names: set[str]) -> bool:
    end = start + len(name)
    return any(
        match.start() <= start and match.end() >= end
        for full in full_names
        if len(full) > len(name) and name in full
        for match in re.finditer(re.escape(full), text)
    )
