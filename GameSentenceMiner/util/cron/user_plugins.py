"""
User Plugin Loader for GameSentenceMiner

This module handles loading and executing user-defined plugins from the
AppData directory. Users can customize GSM behavior by editing their plugins.py file.
"""

import os
from typing import Dict, Any

from GameSentenceMiner.util.config.configuration import get_app_directory, logger


def ensure_plugins_file_exists() -> str:
    """
    Create a default plugins.py template if it doesn't exist.
    
    Returns:
        str: Path to the plugins.py file
    """
    plugin_path = os.path.join(get_app_directory(), "plugins.py")
    
    if not os.path.exists(plugin_path):
        template = '''"""
User Plugins - Runs every 15 minutes

Edit this file to customize GSM behavior. See USER_PLUGINS_README.md for full documentation.
https://github.com/YOUR_REPO/blob/main/GameSentenceMiner/util/cron/USER_PLUGINS_README.md

Your code runs automatically every 15 minutes when enabled.
"""

def main():
    """
    Main entry point - called every 15 minutes by GSM cron system.
    Add your custom code here.
    """
    pass  # Replace with your code
'''
        
        with open(plugin_path, 'w', encoding='utf-8') as f:
            f.write(template)
        logger.info(f"Created default plugins.py at {plugin_path}")
    
    return plugin_path


def execute_user_plugins() -> Dict[str, Any]:
    """
    Load and execute the user's plugins.py file.
    Creates the file if it doesn't exist, then executes it.
    
    Returns:
        Dictionary with execution results
    """
    # Ensure the file exists (create if missing)
    plugin_path = ensure_plugins_file_exists()
    
    result = {
        'plugin_path': plugin_path,
        'executed': False,
        'error': None,
        'main_result': None
    }
    
    try:
        logger.background(f"[Plugin] Loading user plugins from {plugin_path}")
        
        # Read the plugin file
        with open(plugin_path, 'r', encoding='utf-8') as f:
            plugin_code = f.read()
        
        # Create a namespace for execution with all necessary imports
        plugin_namespace = {
            '__name__': 'user_plugins',
            '__file__': plugin_path,
        }
        
        # Execute the plugin code
        exec(plugin_code, plugin_namespace)
        
        # Call the main() function if it exists
        if 'main' in plugin_namespace and callable(plugin_namespace['main']):
            logger.background("[Plugin] Executing main() function")
            main_result = plugin_namespace['main']()
            result['executed'] = True
            result['main_result'] = main_result
            logger.background("[Plugin] User plugins executed successfully")
        else:
            result['error'] = "No main() function found in plugins.py"
            logger.warning("[Plugin] No main() function found in plugins.py")
        
    except Exception as e:
        result['error'] = str(e)
        logger.exception(f"[Plugin] Failed to execute user plugins: {e}")
    
    return result