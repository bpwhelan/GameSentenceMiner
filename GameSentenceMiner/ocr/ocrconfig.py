import configparser
import os

class OCRConfig:
    def __init__(self, config_file=os.path.expanduser("~/.config/owocr_config.ini")):
        self.config_file = config_file
        self.config = configparser.ConfigParser(allow_no_value=True)
        self.raw_config = {}  # Store the raw lines of the config file
        self.load_config()

    def load_config(self):
        if os.path.exists(self.config_file):
            self.raw_config = self._read_config_with_comments()
            self.config.read_dict(self._parse_config_to_dict())
        else:
            self.create_default_config()

    def create_default_config(self):
        self.raw_config = {
            "general": [
                ";engines = avision,alivetext,bing,glens,glensweb,gvision,azure,mangaocr,winrtocr,oneocr,easyocr,rapidocr,ocrspace",
                ";engine = glens",
                "read_from = screencapture",
                "write_to = websocket",
                ";note: this specifies an amount of seconds to wait for auto pausing the program after a successful text recognition. Will be ignored when reading with screen capture. 0 to disable.",
                ";auto_pause = 0",
                ";pause_at_startup = False",
                ";logger_format = <green>{time:HH:mm:ss.SSS}</green> | <level>{message}</level>",
                ";engine_color = cyan",
                "websocket_port = 7331",
                ";delay_secs = 0.5",
                ";notifications = False",
                ";ignore_flag = False",
                ";delete_images = False",
                ";note: this specifies a combo to wait on for pausing the program. As an example: <ctrl>+<shift>+p. The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key",
                ";combo_pause = <ctrl>+<shift>+p",
                ";note: this specifies a combo to wait on for switching the OCR engine. As an example: <ctrl>+<shift>+a. To be used with combo_pause. The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key",
                ";combo_engine_switch = <ctrl>+<shift>+a",
                ";note: screen_capture_area can be empty for the coordinate picker, \"screen_N\" (where N is the screen number starting from 1) for an entire screen, have a manual set of coordinates (x,y,width,height) or a window name (the first matching window title will be used).",
                ";screen_capture_area = ",
                ";screen_capture_area = screen_1",
                ";screen_capture_area = 400,200,1500,600",
                ";screen_capture_area = OBS",
                ";note: if screen_capture_area is a window name, this can be changed to capture inactive windows too.",
                ";screen_capture_only_active_windows = True",
                ";screen_capture_delay_secs = 3",
                ";note: this specifies a combo to wait on for taking a screenshot instead of using the delay. As an example: <ctrl>+<shift>+s. The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key",
                ";screen_capture_combo = <ctrl>+<shift>+s",
            ],
            "winrtocr": [";url = http://aaa.xxx.yyy.zzz:8000"],
            "oneocr": [";url = http://aaa.xxx.yyy.zzz:8001"],
            "azure": [";api_key = api_key_here", ";endpoint = https://YOURPROJECT.cognitiveservices.azure.com/"],
            "mangaocr": ["pretrained_model_name_or_path = kha-white/manga-ocr-base", "force_cpu = False"],
            "easyocr": ["gpu = True"],
            "ocrspace": [";api_key = api_key_here"],
        }
        self.config.read_dict(self._parse_config_to_dict())
        self.save_config()

    def _read_config_with_comments(self):
        with open(self.config_file, "r") as f:
            lines = f.readlines()
        config_data = {}
        current_section = None
        for line in lines:
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                current_section = line[1:-1]
                config_data[current_section] = []
            elif current_section is not None:
                config_data[current_section].append(line)
        return config_data

    def _parse_config_to_dict(self):
        parsed_config = {}
        for section, lines in self.raw_config.items():
            parsed_config[section] = {}
            for line in lines:
                if "=" in line and not line.startswith(";"):
                    key, value = line.split("=", 1)
                    parsed_config[section][key.strip()] = value.strip()
        return parsed_config

    def save_config(self):
        with open(self.config_file, "w") as f:
            for section, lines in self.raw_config.items():
                f.write(f"[{section}]\n")
                for line in lines:
                    f.write(f"{line}\n")

    def get_value(self, section, key):
        if section in self.config and key in self.config[section]:
            return self.config[section][key]
        return None

    def set_value(self, section, key, value):
        if section not in self.config:
            self.raw_config[section] = [] #add section if it does not exist.
        if section not in self.config:
            self.config[section] = {}
        self.config[section][key] = str(value)

        # Update the raw config to keep comments
        found = False
        for i, line in enumerate(self.raw_config[section]):
            if line.startswith(key + " ="):
                self.raw_config[section][i] = f"{key} = {value}"
                found = True
                break
        if not found:
            self.raw_config[section].append(f"{key} = {value}")

        self.save_config()

    def get_section(self, section):
        if section in self.config:
            return dict(self.config[section])
        return None

    def set_screen_capture_area(self, screen_capture_data):
        if not isinstance(screen_capture_data, dict) or "coordinates" not in screen_capture_data:
            raise ValueError("Invalid screen capture data format.")

        coordinates = screen_capture_data["coordinates"]
        if len(coordinates) != 4:
            raise ValueError("Coordinates must contain four values: x, y, width, height.")

        x, y, width, height = coordinates
        self.set_value("general", "screen_capture_area", f"{x},{y},{width},{height}")
