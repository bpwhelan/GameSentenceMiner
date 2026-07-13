from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import Config, OBS, ProfileConfig, StatsConfig, VAD


def test_vad_defaults_to_silero():
    assert VAD().selected_vad_model == configuration.SILERO
    assert ProfileConfig().vad.selected_vad_model == configuration.SILERO


def test_tadoku_stats_defaults_are_safe_and_cleanup_daily_sync():
    stats = StatsConfig()

    assert stats.tadoku_username == ""
    assert stats.tadoku_password == ""
    assert stats.tadoku_session_cookie == ""
    assert stats.tadoku_language_code == "jpn"
    assert stats.tadoku_daily_sync_enabled is False
    assert stats.tadoku_daily_sync_deduplicate is True


def test_obs_replay_buffer_duration_defaults_and_clamps():
    assert OBS().replay_buffer_enabled is True
    assert OBS().replay_buffer_duration_seconds == 300
    assert OBS(replay_buffer_duration_seconds=0).replay_buffer_duration_seconds == 300
    assert OBS(replay_buffer_duration_seconds=999999).replay_buffer_duration_seconds == 86400


def test_missing_vad_model_uses_new_silero_default():
    data = Config.new().to_dict()
    data["configs"]["Default"]["vad"].pop("selected_vad_model", None)

    loaded = Config.from_dict(data)

    assert loaded.configs["Default"].vad.selected_vad_model == configuration.SILERO


def test_vad_model_helpers_include_firered():
    assert VAD(selected_vad_model=configuration.FIRERED).is_firered()
    assert VAD(backup_vad_model=configuration.FIRERED).is_firered()


def test_configs_already_on_silero_record_default_change_as_accepted():
    config = Config.new()
    config.configs["Default"].vad.selected_vad_model = configuration.WHISPER

    assert config.default_config_change_decisions[configuration.SILERO_VAD_DEFAULT_CHANGE_ID] == (
        configuration.DEFAULT_CONFIG_CHANGE_ACCEPTED
    )
    assert configuration.get_pending_default_config_changes(config) == []


def test_pending_silero_default_change_detects_profiles_using_old_whisper_default():
    config = Config(
        configs={
            "Default": ProfileConfig(vad=VAD(selected_vad_model=configuration.WHISPER)),
            "Already Silero": ProfileConfig(vad=VAD(selected_vad_model=configuration.SILERO)),
        },
        current_profile="Default",
    )

    pending = configuration.get_pending_default_config_changes(config)

    assert [notice.change_id for notice in pending] == [configuration.SILERO_VAD_DEFAULT_CHANGE_ID]


def test_accepting_silero_default_change_updates_old_default_profiles_only():
    config = Config(
        configs={
            "Default": ProfileConfig(
                vad=VAD(
                    selected_vad_model=configuration.WHISPER,
                    backup_vad_model=configuration.SILERO,
                )
            ),
            "Already Silero": ProfileConfig(vad=VAD(selected_vad_model=configuration.SILERO)),
        },
        current_profile="Default",
    )

    applied_count = configuration.resolve_default_config_change(
        config,
        configuration.SILERO_VAD_DEFAULT_CHANGE_ID,
        accepted=True,
    )

    assert applied_count == 1
    assert config.configs["Default"].vad.selected_vad_model == configuration.SILERO
    assert config.configs["Default"].vad.backup_vad_model == configuration.OFF
    assert config.configs["Already Silero"].vad.selected_vad_model == configuration.SILERO
    assert config.default_config_change_decisions[configuration.SILERO_VAD_DEFAULT_CHANGE_ID] == (
        configuration.DEFAULT_CONFIG_CHANGE_ACCEPTED
    )
    assert configuration.get_pending_default_config_changes(config) == []


def test_declining_silero_default_change_preserves_whisper_and_suppresses_future_prompt():
    config = Config(
        configs={"Default": ProfileConfig(vad=VAD(selected_vad_model=configuration.WHISPER))},
        current_profile="Default",
    )

    applied_count = configuration.resolve_default_config_change(
        config,
        configuration.SILERO_VAD_DEFAULT_CHANGE_ID,
        accepted=False,
    )

    assert applied_count == 0
    assert config.configs["Default"].vad.selected_vad_model == configuration.WHISPER
    assert config.default_config_change_decisions[configuration.SILERO_VAD_DEFAULT_CHANGE_ID] == (
        configuration.DEFAULT_CONFIG_CHANGE_DECLINED
    )
    assert configuration.get_pending_default_config_changes(config) == []
