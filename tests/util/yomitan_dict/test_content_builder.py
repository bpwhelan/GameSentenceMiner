from GameSentenceMiner.util.yomitan_dict.content_builder import ContentBuilder


def test_strip_spoiler_content_handles_two_formats():
    builder = ContentBuilder()
    text = "a [spoiler]x[/spoiler] b ~!y!~ c"
    assert builder.strip_spoiler_content(text) == "a  b  c"


def test_has_spoiler_tags_detects_vndb_and_anilist():
    builder = ContentBuilder()
    assert builder.has_spoiler_tags("x [spoiler]y[/spoiler]") is True
    assert builder.has_spoiler_tags("x ~!y!~") is True
    assert builder.has_spoiler_tags("plain") is False


def test_parse_vndb_markup_replaces_url_markup_with_text():
    builder = ContentBuilder()
    text = "see [url=https://example.com]this link[/url]"
    assert builder.parse_vndb_markup(text) == "see this link"


def test_format_birthday_handles_list_and_string():
    builder = ContentBuilder()
    assert builder.format_birthday([9, 1]) == "September 1"
    assert builder.format_birthday("unknown") == "unknown"
    assert builder.format_birthday({"bad": True}) == ""


def test_build_physical_stats_line_includes_available_fields():
    builder = ContentBuilder()
    line = builder.build_physical_stats_line(
        {
            "sex": "f",
            "age": 17,
            "height": 160,
            "weight": 50,
            "blood_type": "A",
            "birthday": [1, 2],
        }
    )
    assert "17 years" in line
    assert "160cm" in line
    assert "50kg" in line
    assert "Blood Type A" in line
    assert "Birthday: January 2" in line


def test_build_traits_by_category_filters_by_spoiler_level():
    builder = ContentBuilder(spoiler_level=1)
    traits = builder.build_traits_by_category(
        {
            "personality": [{"name": "kind", "spoiler": 0}, {"name": "secret", "spoiler": 2}],
            "roles": ["hero"],
            "engages_in": [{"name": "fighting", "spoiler": 1}],
            "subject_of": [{"name": "plot_twist", "spoiler": 3}],
        }
    )
    content_lines = [item["content"] for item in traits]
    assert any("Personality: kind" in line for line in content_lines)
    assert all("secret" not in line for line in content_lines)
    assert any("Role: hero" in line for line in content_lines)
    assert any("Activities: fighting" in line for line in content_lines)
    assert all("plot_twist" not in line for line in content_lines)


def test_build_structured_content_level0_has_basic_sections_only():
    builder = ContentBuilder(spoiler_level=0)
    content = builder.build_structured_content(
        {
            "name_original": "orig",
            "name": "romanized",
            "role": "main",
            "description": "desc",
        },
        image_path="img/c1.jpg",
        game_title="Game A",
    )
    items = content["content"]
    tags = [item["tag"] for item in items]
    assert "img" in tags
    assert "span" in tags
    assert "details" not in tags


def test_build_structured_content_level1_strips_spoilers_in_description():
    builder = ContentBuilder(spoiler_level=1)
    content = builder.build_structured_content(
        {
            "name_original": "orig",
            "name": "romanized",
            "role": "side",
            "description": "safe [spoiler]hidden[/spoiler] end",
            "sex": "m",
            "age": 20,
            "personality": ["calm"],
        },
        image_path=None,
        game_title="Game B",
    )

    details_sections = [item for item in content["content"] if item["tag"] == "details"]
    assert len(details_sections) == 2

    description_block = details_sections[0]["content"][1]["content"]
    assert "hidden" not in description_block
    assert "safe" in description_block


def test_build_structured_content_level2_keeps_full_description():
    builder = ContentBuilder(spoiler_level=2)
    content = builder.build_structured_content(
        {
            "name_original": "orig",
            "description": "safe [spoiler]hidden[/spoiler] end",
        },
        image_path=None,
        game_title="",
    )
    details_sections = [item for item in content["content"] if item["tag"] == "details"]
    assert details_sections
    description_block = details_sections[0]["content"][1]["content"]
    assert "[spoiler]hidden[/spoiler]" in description_block


def test_create_term_entry_shape():
    builder = ContentBuilder()
    entry = builder.create_term_entry("term", "reading", "main", 100, {"type": "structured-content"})
    assert entry[0] == "term"
    assert entry[1] == "reading"
    assert entry[2] == "name main"
    assert entry[4] == 100
    assert entry[5] == [{"type": "structured-content"}]
