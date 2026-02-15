"""
Setup script for User Plugins cron job.

This script manages the plugins cron entry that executes user-defined plugins every minute.
The plugins.py file is automatically created in the user's AppData directory if it doesn't exist.

Run this to enable/disable the user plugins system:
    python -m GameSentenceMiner.util.cron.setup_user_plugins_cron
    python -m GameSentenceMiner.util.cron.setup_user_plugins_cron --enable
    python -m GameSentenceMiner.util.cron.setup_user_plugins_cron --disable
"""

from GameSentenceMiner.util.database.cron_table import CronTable
from datetime import datetime

from GameSentenceMiner.util.config.configuration import get_app_directory
from GameSentenceMiner.util.cron.user_plugins import ensure_plugins_file_exists


def setup_user_plugins_cron(enabled: bool = True) -> CronTable:
    """
    Set up or update the user plugins cron job to run every minute.
    
    Args:
        enabled: Whether the cron job should be enabled (default: True)
    
    Returns:
        CronTable: The created or updated cron entry
    """
    # Ensure the plugins.py file exists
    plugin_path = ensure_plugins_file_exists()
    print(f"User plugins file location: {plugin_path}")
    
    # Check if cron already exists
    existing = CronTable.get_by_name('plugins')
    
    if existing:
        print("Plugins scheduled task already exists")
        if enabled and not existing.enabled:
            existing.enable()
            print("✅ Enabled existing plugins scheduled task")
        elif not enabled and existing.enabled:
            existing.disable()
            print("✅ Disabled existing plugins scheduled task")
        else:
            status = "enabled" if existing.enabled else "disabled"
            print(f"Plugins scheduled task is already {status}")
        return existing
    
    # Create new cron entry using the setup method from CronTable
    cron = CronTable.setup_plugins_cron()
    
    if not enabled:
        cron.disable()
        print("✅ Created plugins scheduled task (disabled)")
    else:
        print("✅ Created plugins scheduled task (enabled)")
    
    return cron


def main():
    """Main entry point for the setup script."""
    print("=" * 80)
    print("USER PLUGINS CRON SETUP")
    print("=" * 80)
    
    # Get plugin file location
    plugin_path = ensure_plugins_file_exists()
    app_dir = get_app_directory()
    
    print(f"\nPlugin file location: {plugin_path}")
    print(f"AppData directory: {app_dir}")
    
    # Setup the cron
    cron = setup_user_plugins_cron(enabled=True)
    
    print(f"\n   Schedule: Every minute (minutely)")
    print(f"   Status: {'Enabled' if cron.enabled else 'Disabled'}")
    print(f"   Next run: {datetime.fromtimestamp(cron.next_run)}")
    
    print("\n" + "=" * 80)
    print("HOW TO USE:")
    print("=" * 80)
    print(f"1. Edit your plugins file: {plugin_path}")
    print("2. Add plugin functions from USER_PLUGINS_README.md")
    print("3. Call them in main() function")
    print("4. Save the file - it will run automatically every minute")
    print("\nSee full documentation and examples:")
    print("  GameSentenceMiner/util/cron/USER_PLUGINS_README.md")
    print("\nTo disable the cron job:")
    print("  python -m GameSentenceMiner.util.cron.setup_user_plugins_cron --disable")
    print("To re-enable:")
    print("  python -m GameSentenceMiner.util.cron.setup_user_plugins_cron --enable")
    print("=" * 80)


if __name__ == '__main__':
    import sys
    
    # Check for flags
    if '--disable' in sys.argv:
        cron = setup_user_plugins_cron(enabled=False)
    elif '--enable' in sys.argv:
        cron = setup_user_plugins_cron(enabled=True)
    else:
        main()