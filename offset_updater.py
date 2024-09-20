import toml
import config_reader
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def save_updated_offsets_to_file():
    config_file = "config.toml"  # Ensure this is the correct path to your config file

    try:
        # Load the existing config
        with open(config_file, "r") as f:
            config_data = toml.load(f)

        # Update the audio offsets in the config data
        config_data["audio"]["beginning_offset"] = config_reader.audio_beginning_offset
        config_data["audio"]["end_offset"] = config_reader.audio_end_offset

        # Write the updated config back to the file
        with open(config_file, "w") as f:
            toml.dump(config_data, f)

        logger.info(
            f"Offsets saved to config.toml: beginning_offset={config_reader.audio_beginning_offset}, end_offset={config_reader.audio_end_offset}")

    except Exception as e:
        logger.error(f"Failed to update offsets in config file: {e}")
        print(f"Error saving updated offsets: {e}")


def prompt_for_offset_updates():
    print("Prompting for offset updates...")
    try:
        new_beginning_offset_str = input(
            f"Enter new beginning offset (seconds) [Current: {config_reader.audio_beginning_offset}]: ")
        new_end_offset_str = input(f"Enter new end offset (seconds) [Current: {config_reader.audio_end_offset}]: ")

        if new_beginning_offset_str.strip():
            new_beginning_offset = float(new_beginning_offset_str)
        else:
            new_beginning_offset = config_reader.audio_beginning_offset

        if new_end_offset_str.strip():
            new_end_offset = float(new_end_offset_str)
        else:
            new_end_offset = config_reader.audio_end_offset

        # Update the config_reader variables
        config_reader.audio_beginning_offset = new_beginning_offset
        config_reader.audio_end_offset = new_end_offset

        # Save the updated offsets to the config file
        save_updated_offsets_to_file()

        logger.info(
            f"Offsets updated: Beginning Offset = {new_beginning_offset}, End Offset = {new_end_offset}, no further action required!")

    except ValueError:
        print("Invalid input. Please enter a valid number for offsets.")
        logger.error("Invalid input for offsets.")
