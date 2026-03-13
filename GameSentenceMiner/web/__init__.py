from GameSentenceMiner.web.texthooking_page import app
from GameSentenceMiner.util.config.configuration import is_gsm_cloud_preview_enabled


def register_routes() -> None:
    from GameSentenceMiner.web.anki_api_endpoints import register_anki_api_endpoints
    from GameSentenceMiner.web.database_api import register_database_api_routes
    from GameSentenceMiner.web.goals_api import register_goals_api_routes
    from GameSentenceMiner.web.goals_projection_api import (
        register_goals_projection_api_routes,
    )
    from GameSentenceMiner.web.import_api import register_import_api_routes
    from GameSentenceMiner.web.jiten_database_api import (
        register_jiten_database_api_routes,
    )
    from GameSentenceMiner.web.stats_api import register_stats_api_routes
    from GameSentenceMiner.web.third_party_stats_api import (
        register_third_party_stats_routes,
    )
    from GameSentenceMiner.web.tokenisation_api import (
        register_tokenisation_api_routes,
    )
    from GameSentenceMiner.web.yomitan_api import register_yomitan_api_routes

    register_database_api_routes(app)
    register_jiten_database_api_routes(app)
    register_stats_api_routes(app)
    register_goals_api_routes(app)
    register_goals_projection_api_routes(app)
    register_import_api_routes(app)
    register_third_party_stats_routes(app)
    register_yomitan_api_routes(app)
    register_anki_api_endpoints(app)
    register_tokenisation_api_routes(app)
    if is_gsm_cloud_preview_enabled():
        from GameSentenceMiner.web.cloud_sync_api import register_cloud_sync_api_routes

        register_cloud_sync_api_routes(app)
