import threading
import time
from datetime import datetime

import pyperclip

import util

previous_clipboard = pyperclip.paste()
previous_clipboard_time = datetime.now()


def monitor_clipboard():
    global previous_clipboard_time, previous_clipboard

    # Initial clipboard content
    previous_clipboard = pyperclip.paste()

    while True:
        current_clipboard = pyperclip.paste()

        if current_clipboard != previous_clipboard:
            previous_clipboard = current_clipboard
            previous_clipboard_time = datetime.now()
            util.use_previous_audio = False

        time.sleep(0.05)


# Start monitoring clipboard
# Run monitor_clipboard in the background
clipboard_thread = threading.Thread(target=monitor_clipboard)
clipboard_thread.daemon = True  # Ensures the thread will exit when the main program exits
clipboard_thread.start()
