"""
Jiten.moe Database API Routes

This module serves as the main entry point for all Jiten-related database API routes.
All routes have been refactored into separate modules in the routes/ package for better organization.

The routes are organized by functionality:
- game_management_routes: Game CRUD operations
- jiten_linking_routes: Linking games to external databases (Jiten, VNDB, AniList)
- search_routes: Search operations across Jiten, VNDB, and AniList
- cron_routes: Background job operations
- debug_routes: Debugging and utility endpoints
"""

from .routes import register_all_routes


def register_jiten_database_api_routes(app):
    """
    Register all Jiten-related database API routes with the Flask app.
    
    This function delegates to the routes package which handles all route registration
    through Flask blueprints for better code organization and maintainability.
    
    Args:
        app: Flask application instance
    """
    register_all_routes(app)
