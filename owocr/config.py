import os
import configparser
import argparse
import textwrap
import urllib.request

def str2bool(value):
    if value.lower() == 'true':
        return True
    elif value.lower() == 'false':
        return False
    else:
        raise argparse.ArgumentTypeError('Boolean value expected.')

parser = argparse.ArgumentParser(prog='owocr', description=textwrap.dedent('''\
    Runs OCR in the background.
    It can read images copied to the system clipboard or placed in a directory, images sent via a websocket or a Unix domain socket, or directly capture a screen (or a portion of it) or a window.
    Recognized text can be either saved to system clipboard, appended to a text file or sent via a websocket.
'''))

parser.add_argument('-r', '--read_from', type=str, default=argparse.SUPPRESS,
                    help='Where to read input images from. Can be either "clipboard", "websocket", "unixsocket" (on macOS/Linux), "screencapture", or a path to a directory.')
parser.add_argument('-rs', '--read_from_secondary', type=str, default=argparse.SUPPRESS,
                    help="Optional secondary source to read input images from. Same options as read_from, but they can't both be directory paths.")
parser.add_argument('-w', '--write_to', type=str, default=argparse.SUPPRESS,
                    help='Where to save recognized texts to. Can be either "clipboard", "websocket", or a path to a text file.')
parser.add_argument('-e', '--engine', type=str, default=argparse.SUPPRESS,
                    help='OCR engine to use. Available: "mangaocr", "glens", "glensweb", "bing", "gvision", "avision", "alivetext", "azure", "winrtocr", "oneocr", "easyocr", "rapidocr", "ocrspace".')
parser.add_argument('-p', '--pause_at_startup', action='store_true', default=argparse.SUPPRESS,
                    help='Pause at startup.')
parser.add_argument('-i', '--ignore_flag', action='store_true', default=argparse.SUPPRESS,
                    help='Process flagged clipboard images (images that are copied to the clipboard with the *ocr_ignore* string).')
parser.add_argument('-d', '--delete_images', action='store_true', default=argparse.SUPPRESS,
                    help='Delete image files after processing when reading from a directory.')
parser.add_argument('-n', '--notifications', action='store_true', default=argparse.SUPPRESS,
                    help='Show an operating system notification with the detected text. Will be ignored when reading with screen capture, unless screen_capture_combo is set.')
parser.add_argument('-a', '--auto_pause', type=float, default=argparse.SUPPRESS,
                    help='Automatically pause the program after the specified amount of seconds since the last successful text recognition. Will be ignored when reading with screen capture, unless screen_capture_combo is set. 0 to disable.')
parser.add_argument('-cp', '--combo_pause', type=str, default=argparse.SUPPRESS,
                    help='Combo to wait on for pausing the program. As an example: "<ctrl>+<shift>+p". The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key')
parser.add_argument('-cs', '--combo_engine_switch', type=str, default=argparse.SUPPRESS,
                    help='Combo to wait on for switching the OCR engine. As an example: "<ctrl>+<shift>+a". To be used with combo_pause. The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key')
parser.add_argument('-sa', '--screen_capture_area', type=str, default=argparse.SUPPRESS,
                    help='Area to target when reading with screen capture. Can be either empty (automatic selector), a set of coordinates (x,y,width,height), "screen_N" (captures a whole screen, where N is the screen number starting from 1) or a window name (the first matching window title will be used).')
parser.add_argument('-sd', '--screen_capture_delay_secs', type=float, default=argparse.SUPPRESS,
                    help='Delay (in seconds) between screenshots when reading with screen capture.')
parser.add_argument('-sw', '--screen_capture_only_active_windows', type=str2bool, default=argparse.SUPPRESS,
                    help="When reading with screen capture and screen_capture_area is a window name, only target the window while it's active.")
parser.add_argument('-sc', '--screen_capture_combo', type=str, default=argparse.SUPPRESS,
                    help='When reading with screen capture, combo to wait on for taking a screenshot instead of using the delay. As an example: "<ctrl>+<shift>+s". The list of keys can be found here: https://pynput.readthedocs.io/en/latest/keyboard.html#pynput.keyboard.Key')

class Config:
    has_config = False
    downloaded_config = False
    config_path = os.path.join(os.path.expanduser('~'),'.config','owocr_config.ini')
    __general_config = {}
    __engine_config = {}
    __default_config = {
        'read_from': 'clipboard',
        'read_from_secondary': '',
        'write_to': 'clipboard',
        'engine': '',
        'pause_at_startup': False,
        'auto_pause' : 0,
        'ignore_flag': False,
        'delete_images': False,
        'engines': [],
        'logger_format': '<green>{time:HH:mm:ss.SSS}</green> | <level>{message}</level>',
        'engine_color': 'cyan',
        'delay_secs': 0.5,
        'websocket_port': 7331,
        'notifications': False,
        'combo_pause': '',
        'combo_engine_switch': '',
        'screen_capture_area': '',
        'screen_capture_delay_secs': 3,
        'screen_capture_only_active_windows': True,
        'screen_capture_combo': '',
        'screen_capture_old_macos_api': False
    }

    def __parse(self, value):
        value = value.strip()
        if value.lower() == 'false':
            return False
        if value.lower() == 'true':
            return True
        try:
            int(value)
            return int(value)
        except ValueError:
            pass
        try:
            float(value)
            return float(value)
        except ValueError:
            pass
        return value

    def __init__(self, parse_args=True):
        if parse_args:
            args = parser.parse_args()
            self.__provided_cli_args = vars(args)
        else:
            self.__provided_cli_args = {}
        config = configparser.ConfigParser()
        res = config.read(self.config_path)

        if len(res) == 0:
            try:
                config_folder = os.path.join(os.path.expanduser('~'),'.config')
                if not os.path.isdir(config_folder):
                    os.makedirs(config_folder)
                urllib.request.urlretrieve('https://github.com/AuroraWright/owocr/raw/master/owocr_config.ini', self.config_path)
                self.downloaded_config = True
            finally:
                return

        self.has_config = True
        for key in config:
            if key == 'general':
                for sub_key in config[key]:
                    self.__general_config[sub_key.lower()] = self.__parse(config[key][sub_key])
            elif key != 'DEFAULT':
                self.__engine_config[key.lower()] = {}
                for sub_key in config[key]:
                    self.__engine_config[key.lower()][sub_key.lower()] = self.__parse(config[key][sub_key])

    def get_general(self, value, default_value=None):
        if self.__provided_cli_args.get(value, None) is not None:
            return self.__provided_cli_args[value]
        try:
            return self.__general_config[value]
        except KeyError:
            if default_value:
                return default_value
            if value in self.__default_config:
                return self.__default_config[value]
            else:
                return None

    def get_engine(self, value):
        try:
            return self.__engine_config[value]
        except KeyError:
            return None

config = Config(False)
