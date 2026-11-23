from GameSentenceMiner.ai.features.character_summary import CharacterSummaryService


def test_character_summary_omits_portraits_and_rejects_provider_error():
    class Provider:
        def generate_raw_prompt(self, prompt, request_kind):
            assert request_kind == "character_summary"
            assert '"name":"Takeru"' in prompt
            assert '"personality":["Impulsive"]' in prompt
            assert "image_base64" not in prompt
            assert len(prompt.encode()) < 17 * 1024
            return " Processing failed: Processing failed: context_length_exceeded"

    data = {
        "characters": {
            "side": [{"name": str(i), "description": "武" * 1000} for i in range(60)],
            "main": [
                {
                    "name": "Takeru",
                    "image_base64": "x" * 810_000,
                    "personality": [{"name": "Impulsive", "spoiler": 0}],
                }
            ],
        }
    }
    assert CharacterSummaryService(logger=None).generate_from_vndb(data, Provider()) is None
