import ttkbootstrap as ttk
from ttkbootstrap.constants import *
from tkinter import filedialog
import threading
import time

from config_gui import ConfigApp


# Placeholder functions
def start_recording():
    output_label['text'] = "Recording started..."
    threading.Thread(target=record_audio).start()

def stop_recording():
    global recording
    recording = False
    output_label['text'] = "Recording stopped."

recording = False

def record_audio():
    global recording
    recording = True
    while recording:
        time.sleep(1)  # Simulate recording logic

def launch_config_gui():
    config_window = ConfigApp(app)

# Main GUI
app = ttk.Window(themename="solar")
app.title("Game Sentence Miner")
app.geometry("400x300")

# Widgets
title_label = ttk.Label(app, text="Game Sentence Miner", font=("Helvetica", 18))
title_label.pack(pady=20)

start_button = ttk.Button(app, text="Start Recording", command=start_recording, bootstyle=SUCCESS)
start_button.pack(pady=10)

stop_button = ttk.Button(app, text="Stop Recording", command=stop_recording, bootstyle=DANGER)
stop_button.pack(pady=10)

output_label = ttk.Label(app, text="", font=("Helvetica", 12))
output_label.pack(pady=20)

settings_button = ttk.Button(app, text="Open Config", command=launch_config_gui)
settings_button.pack(pady=10)

app.mainloop()