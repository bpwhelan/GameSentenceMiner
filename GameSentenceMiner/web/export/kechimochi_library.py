from __future__ import annotations

from GameSentenceMiner.web.export.base import BaseStatsExporter, NormalizedLibraryRecord


class KechimochiLibraryExporter(BaseStatsExporter):
    format_key = "kechimochi_library"
    label = "Kechimochi Media Library"
    description = "Exports your GSM library metadata as a separate Kechimochi media library CSV."
    filename_prefix = "gsm_kechimochi_media_library"
    supports_date_range = False
    supports_external_stats = False

    def get_headers(self) -> list[str]:
        return [
            "Title",
            "Media Type",
            "Status",
            "Language",
            "Description",
            "Content Type",
            "Extra Data",
            "Cover Image (Base64)",
        ]

    def build_row(self, record: NormalizedLibraryRecord) -> list[str]:
        return [
            record.title,
            record.media_type,
            record.status,
            record.language,
            record.description,
            record.content_type,
            record.extra_data_json,
            record.cover_image_base64,
        ]
