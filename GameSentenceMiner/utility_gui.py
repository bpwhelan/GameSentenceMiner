import json
import os
import tkinter as tk
from tkinter import ttk

from GameSentenceMiner import obs
from GameSentenceMiner.configuration import logger, get_app_directory, get_config


class UtilityApp:
    def __init__(self, root):
        self.root = root
        self.items = []
        self.play_audio_buttons = []
        self.get_screenshot_buttons = []
        self.checkboxes = []
        self.multi_mine_window = None  # Store the multi-mine window reference
        self.checkbox_frame = None
        self.line_for_audio = None
        self.line_for_screenshot = None
        self.line_counter = 0

        style = ttk.Style()
        style.configure("TCheckbutton", font=("Arial", 20))  # Change the font and size
        self.config_file = os.path.join(get_app_directory(), "multi-mine-window-config.json")
        self.load_window_config()


    def save_window_config(self):
        if self.multi_mine_window:
            config = {
                "x": self.multi_mine_window.winfo_x(),
                "y": self.multi_mine_window.winfo_y(),
                "width": self.multi_mine_window.winfo_width(),
                "height": self.multi_mine_window.winfo_height()
            }
            print(config)
            with open(self.config_file, "w") as f:
                json.dump(config, f)

    def load_window_config(self):
        if os.path.exists(self.config_file):
            with open(self.config_file, "r") as f:
                config = json.load(f)
                self.window_x = config.get("x", 100)
                self.window_y = config.get("y", 100)
                self.window_width = config.get("width", 800)
                self.window_height = config.get("height", 400)
        else:
            self.window_x = 100
            self.window_y = 100
            self.window_width = 800
            self.window_height = 400

    def show(self):
        if not self.multi_mine_window or not tk.Toplevel.winfo_exists(self.multi_mine_window):
            self.multi_mine_window = tk.Toplevel(self.root)
            self.multi_mine_window.title("Multi Mine Window")

            self.multi_mine_window.geometry(f"{self.window_width}x{self.window_height}+{self.window_x}+{self.window_y}")

            self.multi_mine_window.minsize(800, 400)

            self.checkbox_frame = ttk.Frame(self.multi_mine_window)
            self.checkbox_frame.pack(padx=10, pady=10, fill="both", expand=True)

            for line, var in self.items:
                self.add_checkbox_to_gui(line, var)

            self.multi_mine_window.protocol("WM_DELETE_WINDOW", self.on_close)
        else:
            self.multi_mine_window.deiconify()
            self.multi_mine_window.lift()

    def on_close(self):
        self.save_window_config()
        self.multi_mine_window.withdraw()

    def add_text(self, line):
        if line.text:
            try:
                var = tk.BooleanVar()
                self.items.append((line, var))
            except Exception as e:
                logger.error(f"NOT AN ERROR: Attempted to add text to multi-mine window, before it was initialized: {e}")
                return

            if len(self.items) > 10:
                if self.checkboxes:
                    self.checkboxes[0].destroy()
                    self.checkboxes.pop(0)
                self.items.pop(0)
                if self.play_audio_buttons:
                    self.play_audio_buttons[0].destroy()
                    self.play_audio_buttons.pop(0)
                if self.get_screenshot_buttons:
                    self.get_screenshot_buttons[0].destroy()
                    self.get_screenshot_buttons.pop(0)

            if self.multi_mine_window and tk.Toplevel.winfo_exists(self.multi_mine_window):
                self.add_checkbox_to_gui(line, var)
        self.line_for_audio = None
        self.line_for_screenshot = None

    def add_checkbox_to_gui(self, line, var):
        """ Add a single checkbox without repainting everything. """
        if self.checkbox_frame:
            column = 0
            if get_config().advanced.show_screenshot_buttons:
                get_screenshot_button = ttk.Button(self.checkbox_frame, text="📸", command=lambda: self.take_screenshot(line))
                get_screenshot_button.grid(row=self.line_counter, column=column, sticky='w', padx=5)
                self.get_screenshot_buttons.append(get_screenshot_button)
                column += 1

            if get_config().advanced.video_player_path or get_config().advanced.audio_player_path:
                play_audio_button = ttk.Button(self.checkbox_frame, text="🔊", command=lambda: self.play_audio(line))
                play_audio_button.grid(row=self.line_counter, column=column, sticky='w', padx=5)
                self.play_audio_buttons.append(play_audio_button)
                column += 1

            chk = ttk.Checkbutton(self.checkbox_frame, text=f"{line.time.strftime('%H:%M:%S')} - {line.text}", variable=var)
            chk.grid(row=self.line_counter, column=column, sticky='w', padx=5)
            self.checkboxes.append(chk)

            self.line_counter += 1


    def play_audio(self, line):
        self.line_for_audio = line
        obs.save_replay_buffer()

    def take_screenshot(self, line):
        self.line_for_screenshot = line
        obs.save_replay_buffer()


    # def update_multi_mine_window(self):
    #     for widget in self.multi_mine_window.winfo_children():
    #         widget.destroy()
    #
    #     for i, (text, var, time) in enumerate(self.items):
    #         time: datetime
    #         chk = ttk.Checkbutton(self.checkbox_frame, text=f"{time.strftime('%H:%M:%S')} - {text}", variable=var)
    #         chk.pack(anchor='w')

    def get_selected_lines(self):
        filtered_items = [line for line, var in self.items if var.get()]
        return filtered_items if len(filtered_items) > 0 else []


    def get_next_line_timing(self):
        selected_lines = [line for line, var in self.items if var.get()]

        if len(selected_lines) >= 2:
            last_checked_index = max(i for i, (_, var) in enumerate(self.items) if var.get())

            if last_checked_index + 1 < len(self.items):
                next_time = self.items[last_checked_index + 1][0].time
            else:
                next_time = 0

            return next_time
        if len(selected_lines) == 1:
            return selected_lines[0].get_next_time()

        return None


    def lines_selected(self):
        filter_times = [line.time for line, var in self.items if var.get()]
        if len(filter_times) > 0:
            return True
        return False

    # def validate_checkboxes(self, *args):
    #     logger.debug("Validating checkboxes")
    #     found_checked = False
    #     found_unchecked = False
    #     for _, var in self.items:
    #         if var.get():
    #             if found_unchecked:
    #                 messagebox.showinfo("Invalid", "Can only select neighboring checkboxes.")
    #                 break
    #             found_checked = True
    #         if found_checked and not var.get():
    #             found_unchecked = True

    def reset_checkboxes(self):
        for _, var in self.items:
            var.set(False)
        # if self.multi_mine_window:
        #     for checkbox in self.checkboxes:
        #         checkbox.set(False)


def init_utility_window(root):
    global utility_window
    utility_window = UtilityApp(root)
    return utility_window

def get_utility_window():
    return utility_window

utility_window: UtilityApp = None


if __name__ == "__main__":
    root = tk.Tk()
    app = UtilityApp(root)
    root.mainloop()
