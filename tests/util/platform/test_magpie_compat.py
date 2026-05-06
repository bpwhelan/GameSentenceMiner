from GameSentenceMiner.util.platform.magpie_compat import normalize_magpie_info


def test_normalize_magpie_info_rejects_zero_or_inverted_rectangles():
    assert (
        normalize_magpie_info(
            {
                "magpieWindowTopEdgePosition": 0,
                "magpieWindowBottomEdgePosition": 0,
                "magpieWindowLeftEdgePosition": 0,
                "magpieWindowRightEdgePosition": 0,
                "sourceWindowLeftEdgePosition": 620,
                "sourceWindowTopEdgePosition": 342,
                "sourceWindowRightEdgePosition": 620,
                "sourceWindowBottomEdgePosition": 1062,
            }
        )
        is None
    )


def test_normalize_magpie_info_coerces_numeric_values_and_preserves_valid_geometry():
    info = normalize_magpie_info(
        {
            "magpieWindowTopEdgePosition": "0",
            "magpieWindowBottomEdgePosition": "1440",
            "magpieWindowLeftEdgePosition": "0",
            "magpieWindowRightEdgePosition": "2560",
            "sourceWindowLeftEdgePosition": "620",
            "sourceWindowTopEdgePosition": "342",
            "sourceWindowRightEdgePosition": "1900",
            "sourceWindowBottomEdgePosition": "1062",
        }
    )

    assert info == {
        "magpieWindowTopEdgePosition": 0,
        "magpieWindowBottomEdgePosition": 1440,
        "magpieWindowLeftEdgePosition": 0,
        "magpieWindowRightEdgePosition": 2560,
        "sourceWindowLeftEdgePosition": 620,
        "sourceWindowTopEdgePosition": 342,
        "sourceWindowRightEdgePosition": 1900,
        "sourceWindowBottomEdgePosition": 1062,
    }
