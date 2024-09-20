import subprocess
import os
import requests
import shutil
from datetime import datetime

# Define your repository details (modify as needed)
REPO_URL = "https://github.com/bpwhelan/TrimJapaneseGameAudio"
CHECK_VERSION_URL = "https://api.github.com/repos/bpwhelan/TrimJapaneseGameAudio/releases/latest"

# Local version file path (this is a file where you store the current version number)
VERSION_FILE = "version.txt"
local_version = '0.0.0'


# Helper function to run git commands
def run_command(command):
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}")
    return result.stdout


# Helper function to get the current date string (short format: month-day)
def get_date_string():
    return datetime.now().strftime("%m-%d")  # Returns the date in MM-DD format


# Step 1: Check for new updates by comparing local and remote versions
def check_for_updates():
    global local_version
    # Get the local version
    if os.path.exists(VERSION_FILE):
        with open(VERSION_FILE, 'r') as f:
            local_version = f.read().strip()
    else:
        local_version = "0.0.0"

    # Get the latest version from the GitHub API
    response = requests.get(CHECK_VERSION_URL)
    latest_version = response.json()['tag_name']

    if latest_version != local_version:
        print(f"Update available: {latest_version} (current version: {local_version})")
        return latest_version
    else:
        print("No updates available.")
        return None


# Step 2: Detect uncommitted local changes
def check_for_uncommitted_changes():
    status_output = run_command("git status --porcelain")
    if status_output.strip():
        return True  # Uncommitted changes detected
    return False  # No uncommitted changes


# Step 3: Backup files before updating with date-based suffix
def backup_local_files():
    print("Backing up local files before updating...")
    if not os.path.exists("backup"):
        os.makedirs("backup")

    date_suffix = get_date_string()  # Get current date as suffix
    # Backing up only modified files (those tracked by git)
    modified_files = run_command("git ls-files -m").splitlines()
    for file in modified_files:
        new_file_name = f"backup/{file}_{local_version}"
        print(f"Backing up {file} to {new_file_name}")
        shutil.copy2(file, new_file_name)
    print("Backup completed.")


# Step 4: Pull the latest changes from the remote repository (without hard reset)
def update_files():
    print("Updating files from the remote repository...")
    run_command("git fetch --all")
    run_command("git stash")  # Stash local changes
    run_command("git pull origin main")  # Pull latest changes
    # run_git_command("git stash pop")  # Reapply stashed changes
    run_command("pip install -r requirements.txt")
    print("Update completed.")


# Step 5: Ask for user confirmation if local changes are detected
def handle_local_changes():
    if check_for_uncommitted_changes():
        print("Uncommitted local changes detected.")
        choice = input(
            "Do you want to backup and overwrite local changes with the remote version? (y/n): ").strip().lower()
        if choice == 'y':
            backup_local_files()
            update_files()
        else:
            print("Update aborted. Local changes were not overwritten.")
    else:
        update_files()


# Main function to handle the updater logic
def main():
    latest_version = check_for_updates()
    if latest_version:
        handle_local_changes()
        # Optionally update the local version file
        with open(VERSION_FILE, 'w') as f:
            f.write(latest_version)
    else:
        print("Your system is up-to-date.")


if __name__ == "__main__":
    main()
