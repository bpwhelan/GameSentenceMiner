"""
Routes Package

Aggregates all API route blueprints for the Jiten database API.
Provides a single function to register all routes with the Flask app.
"""

from .cron_routes import cron_bp
from .debug_routes import debug_bp
from .game_management_routes import game_management_bp
from .jiten_linking_routes import jiten_linking_bp
from .search_routes import search_bp


def register_all_routes(app):
    """
    Register all Jiten-related database API routes with the Flask app.
    
    This function registers all blueprints from the routes package,
    providing a clean separation of concerns for different route categories.
    
    Args:
        app: Flask application instance
    """
    # Register all blueprints
    app.register_blueprint(game_management_bp)
    app.register_blueprint(jiten_linking_bp)
    app.register_blueprint(search_bp)
    app.register_blueprint(cron_bp)
    app.register_blueprint(debug_bp)


__all__ = [
    'register_all_routes',
    'game_management_bp',
    'jiten_linking_bp',
    'search_bp',
    'cron_bp',
    'debug_bp',
]
