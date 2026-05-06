from GameSentenceMiner.util.shared.spoiler_utils import (
    SpoilerFormat,
    contains_spoiler_content,
    strip_spoiler_content,
    mask_spoiler_content,
    has_vndb_spoiler_tags,
    strip_vndb_spoiler_content,
    has_anilist_spoiler_tags,
    strip_anilist_spoiler_tags,
)


def test_contains_spoiler_content_for_both_formats():
    assert contains_spoiler_content("a [spoiler]secret[/spoiler] b", SpoilerFormat.VNDB)
    assert contains_spoiler_content("a ~!secret!~ b", SpoilerFormat.ANILIST)
    assert not contains_spoiler_content("plain text", SpoilerFormat.VNDB)


def test_strip_spoiler_content_remove_content():
    text = "start [spoiler]hidden[/spoiler] end"
    assert strip_spoiler_content(text, SpoilerFormat.VNDB, keep_content=False) == "start  end"


def test_strip_spoiler_content_keep_content():
    text_vndb = "start [spoiler]hidden[/spoiler] end"
    text_anilist = "start ~!hidden!~ end"
    assert strip_spoiler_content(text_vndb, SpoilerFormat.VNDB, keep_content=True) == "start hidden end"
    assert strip_spoiler_content(text_anilist, SpoilerFormat.ANILIST, keep_content=True) == "start hidden end"


def test_mask_spoiler_content_replaces_sections():
    assert mask_spoiler_content("X [spoiler]Y[/spoiler] Z", SpoilerFormat.VNDB) == "X [SPOILER] Z"
    assert mask_spoiler_content("X ~!Y!~ Z", SpoilerFormat.ANILIST, "[REDACTED]") == "X [REDACTED] Z"


def test_convenience_helpers():
    vndb = "foo [spoiler]bar[/spoiler]"
    ani = "foo ~!bar!~"

    assert has_vndb_spoiler_tags(vndb) is True
    assert strip_vndb_spoiler_content(vndb) == "foo"

    assert has_anilist_spoiler_tags(ani) is True
    assert strip_anilist_spoiler_tags(ani) == "foo bar"
