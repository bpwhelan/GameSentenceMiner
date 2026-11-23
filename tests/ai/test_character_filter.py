from GameSentenceMiner.ai.features.character_filter import CharacterContext


def test_character_summary_is_filtered_against_target_and_surrounding_lines():
    cast = CharacterContext.from_metadata(
        "**CHARACTER LIST**:\n鑑 純夏 (Kagami Sumika): bubbly\nAnn: reserved\nAnna: outgoing",
        {
            "characters": {
                "main": [
                    {"name_original": "鑑 純夏", "aliases": ["すみちゃん"]},
                    {"name_original": "鑑 純夏", "name": "Kagami Sumika"},
                ],
                "side": [{"name": "Ann", "aliases": ["Chief"]}, {"name": "Anna", "aliases": ["Chief"]}],
            }
        },
    )
    assert cast.relevant_to("【鑑純夏】私が行く", "Anna said so.") == "鑑 純夏 (Kagami Sumika): bubbly\nAnna: outgoing"
    assert cast.relevant_to("<b>すみちゃん</b>が来る", "") == "鑑 純夏 (Kagami Sumika): bubbly"
    assert cast.relevant_to("Ask Chief tomorrow.", "") == ""
    assert cast.relevant_to("She was there.", "") == ""
    assert cast.relevant_to('<span title="Ann">Hello</span>', "") == ""


def test_name_parts_match_only_when_unique_even_across_unsummarized_characters():
    cast = CharacterContext.from_metadata(
        "鑑 純夏 (Kagami Sumika): bubbly\nMia Park: reserved\nJordan Reed: outgoing",
        {
            "characters": {
                "main": [{"name_original": "鑑 純夏", "name": "Kagami Sumika", "aliases": ["Class Rep"]}],
                "side": [{"name": "Mia Park"}, {"name": "John Park"}],
            }
        },
    )
    sumika = "鑑 純夏 (Kagami Sumika): bubbly"
    assert cast.relevant_to("純夏が来た。", "") == sumika
    assert cast.relevant_to("「鑑さん！」", "") == sumika
    assert cast.relevant_to("Sumika is here.", "") == sumika
    assert cast.relevant_to("Kagami is here.", "") == sumika
    assert cast.relevant_to("図鑑はここ。", "") == ""
    assert cast.relevant_to("Class starts soon.", "") == ""
    assert cast.relevant_to("Park arrives tomorrow.", "") == ""
    assert cast.relevant_to("They called Mia.", "Reed is out.") == "Mia Park: reserved\nJordan Reed: outgoing"
