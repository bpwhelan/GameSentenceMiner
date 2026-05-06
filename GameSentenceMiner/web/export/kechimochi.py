from __future__ import annotations

from GameSentenceMiner.web.export.base import (
    BaseStatsExporter,
    NormalizedActivityRecord,
)


class KechimochiStatsExporter(BaseStatsExporter):
    format_key = "kechimochi"
    label = "Kechimochi Activity Logs"
    description = "Exports GSM stats as Kechimochi-compatible daily activity CSV."
    filename_prefix = "gsm_kechimochi_activity_logs"

    def get_headers(self) -> list[str]:
        return [
            "Date",
            "Log Name",
            "Media Type",
            "Duration",
            "Language",
            "Characters",
            "Activity Type",
        ]

    def build_row(self, record: NormalizedActivityRecord) -> list[str | int]:
        return [
            record.date,
            record.log_name,
            record.media_type,
            record.duration_minutes,
            record.language,
            record.characters,
            record.activity_type,
        ]
