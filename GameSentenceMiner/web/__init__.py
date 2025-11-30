from GameSentenceMiner.web.texthooking_page import app
from GameSentenceMiner.web.database_api import register_database_api_routes
from GameSentenceMiner.web.jiten_database_api import register_jiten_database_api_routes
from GameSentenceMiner.web.stats_api import register_stats_api_routes
from GameSentenceMiner.web.goals_api import register_goals_api_routes
from GameSentenceMiner.web.anki_api_endpoints import register_anki_api_endpoints

register_database_api_routes(app)
register_jiten_database_api_routes(app)
register_stats_api_routes(app)
register_goals_api_routes(app)

# Register Anki API routes

register_anki_api_endpoints(app)

print("Web module initialized.")