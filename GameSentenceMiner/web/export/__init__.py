from __future__ import annotations

from GameSentenceMiner.web.export.base import (
    BaseStatsExporter,
    NormalizedActivityRecord,
    NormalizedLibraryRecord,
)
from GameSentenceMiner.web.export.kechimochi import KechimochiStatsExporter
from GameSentenceMiner.web.export.kechimochi_library import (
    KechimochiLibraryExporter,
)

_EXPORTERS: dict[str, BaseStatsExporter] = {
    KechimochiStatsExporter.format_key: KechimochiStatsExporter(),
    KechimochiLibraryExporter.format_key: KechimochiLibraryExporter(),
}


def get_stats_exporter(format_key: str) -> BaseStatsExporter | None:
    return _EXPORTERS.get(format_key)


def list_stats_exporters() -> list[BaseStatsExporter]:
    return list(_EXPORTERS.values())


__all__ = [
    "BaseStatsExporter",
    "NormalizedActivityRecord",
    "NormalizedLibraryRecord",
    "get_stats_exporter",
    "list_stats_exporters",
]
