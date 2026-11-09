from concurrent.futures import ThreadPoolExecutor

from GameSentenceMiner.util.config.configuration import ProfileConfig, get_config, use_profile_config


def test_old_profiles_leave_session_review_disabled():
    profile = ProfileConfig.from_dict({"name": "Old profile", "features": {"generate_longplay": True}})
    assert profile.features.review_after_session.enabled is False
    assert profile.features.review_after_session.max_future_context_lines == 3
    assert profile.features.review_after_session.notify_on_startup is True
    assert profile.features.generate_longplay is True


def test_session_review_options_round_trip_with_profile():
    profile = ProfileConfig()
    settings = profile.features.review_after_session
    settings.enabled = True
    settings.delay_seconds = 11
    settings.cleanup_anki_media = False
    settings.max_future_context_lines = 5
    settings.notify_on_startup = False
    restored = ProfileConfig.from_json(profile.to_json())
    assert restored.features.review_after_session == settings


def test_captured_profile_does_not_change_other_threads():
    original = get_config()
    captured = ProfileConfig(name="Review profile")
    with ThreadPoolExecutor(max_workers=1) as pool, use_profile_config(captured):
        assert get_config() is captured
        assert pool.submit(get_config).result() is original
    assert get_config() is original
