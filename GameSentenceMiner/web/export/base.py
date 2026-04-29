from __future__ import annotations

import csv
import datetime as dt
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


@dataclass(slots=True)
class NormalizedActivityRecord:
    date: str
    log_name: str
    media_type: str
    duration_minutes: int
    language: str
    characters: int
    activity_type: str


@dataclass(slots=True)
class NormalizedLibraryRecord:
    title: str
    media_type: str
    status: str
    language: str
    description: str
    content_type: str
    extra_data_json: str
    cover_image_base64: str


class BaseStatsExporter(ABC):
    format_key: str = ""
    label: str = ""
    description: str = ""
    filename_prefix: str = "gsm_stats"
    supports_date_range: bool = True
    supports_external_stats: bool = True

    def metadata(self) -> dict[str, str | bool]:
        return {
            "id": self.format_key,
            "label": self.label,
            "description": self.description,
            "supports_date_range": self.supports_date_range,
            "supports_external_stats": self.supports_external_stats,
        }

    def build_filename(self, *, now: dt.datetime | None = None) -> str:
        timestamp = (now or dt.datetime.now()).strftime("%Y%m%d_%H%M%S")
        return f"{self.filename_prefix}_{timestamp}.csv"

    @abstractmethod
    def get_headers(self) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def build_row(self, record) -> list[str | int]:
        raise NotImplementedError

    def export_to_file(
        self,
        records: Iterable,
        output_path: str | Path,
        *,
        progress_cb: Callable[[int, int], None] | None = None,
    ) -> int:
        rows = list(records)
        total = len(rows)

        with open(output_path, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(self.get_headers())

            for index, record in enumerate(rows, start=1):
                writer.writerow(self.build_row(record))
                if progress_cb and (index == total or index % 50 == 0):
                    progress_cb(index, total)

        return total
