import tkinter as tk
from tkinter import scrolledtext
from PIL import Image, ImageTk

import ttkbootstrap as ttk
from GameSentenceMiner.util.configuration import get_config, logger, gsm_state

import platform
import subprocess
import os

class AnkiConfirmationDialog(tk.Toplevel):
    """
    A modal dialog to confirm Anki card details and choose an audio option.
    """
    def __init__(self, parent, config_app, expression, sentence, screenshot_path, audio_path, translation, screenshot_timestamp):
        super().__init__(parent)
        self.config_app = config_app
        self.screenshot_timestamp = screenshot_timestamp
        
        # Initialize screenshot_path here, will be updated by button if needed
        self.screenshot_path = screenshot_path 

        self.title("Confirm Anki Card Details")
        self.result = None  # This will store the user's choice

        # This makes the dialog block interaction with other windows.
        self.grab_set()

        # --- Create and lay out widgets ---
        self._create_widgets(expression, sentence, screenshot_path, audio_path, translation)

        # --- Smarter Centering Logic ---
        self.update_idletasks()

        if parent.state() == 'withdrawn':
            screen_width = self.winfo_screenwidth()
            screen_height = self.winfo_screenheight()
            dialog_width = self.winfo_width()
            dialog_height = self.winfo_height()
            x = (screen_width // 2) - (dialog_width // 2)
            y = (screen_height // 2) - (dialog_height // 2)
            self.geometry(f'+{x}+{y}')
        else:
            self.transient(parent)
            parent_x = parent.winfo_x()
            parent_y = parent.winfo_y()
            parent_width = parent.winfo_width()
            parent_height = parent.winfo_height()
            dialog_width = self.winfo_width()
            dialog_height = self.winfo_height()
            x = parent_x + (parent_width // 2) - (dialog_width // 2)
            y = parent_y + (parent_height // 2) - (dialog_height // 2)
            self.geometry(f'+{x}+{y}')

        self.protocol("WM_DELETE_WINDOW", self._on_cancel)
        self.attributes('-topmost', True)
        self.wait_window(self)

    def _create_widgets(self, expression, sentence, screenshot_path, audio_path, translation):
        main_frame = ttk.Frame(self, padding=20)
        main_frame.pack(expand=True, fill="both")

        row = 0

        # Expression
        ttk.Label(main_frame, text=f"{get_config().anki.word_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        ttk.Label(main_frame, text=expression, wraplength=400, justify="left").grid(row=row, column=1, sticky="w", padx=5, pady=2)
        row += 1

        # Sentence
        ttk.Label(main_frame, text=f"{get_config().anki.sentence_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        sentence_text = scrolledtext.ScrolledText(main_frame, height=4, width=50, wrap=tk.WORD)
        sentence_text.insert(tk.END, sentence)
        sentence_text.grid(row=row, column=1, sticky="w", padx=5, pady=2)
        self.sentence_text = sentence_text
        row += 1

        # Translation
        ttk.Label(main_frame, text=f"{get_config().ai.anki_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        translation_text = scrolledtext.ScrolledText(main_frame, height=4, width=50, wrap=tk.WORD)
        translation_text.insert(tk.END, translation)
        translation_text.grid(row=row, column=1, sticky="w", padx=5, pady=2)
        self.translation_text = translation_text
        row += 1

        # Screenshot
        ttk.Label(main_frame, text=f"{get_config().anki.picture_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        
        # <<< CHANGED: Step 1 - Create and store the label for the image
        self.image_label = ttk.Label(main_frame)
        self.image_label.grid(row=row, column=1, sticky="w", padx=5, pady=2)
        
        try:
            img = Image.open(screenshot_path)
            img.thumbnail((400, 300))
            self.photo_image = ImageTk.PhotoImage(img)
            # Configure the label we just created
            self.image_label.config(image=self.photo_image)
            # Keep a reference on the widget itself to prevent garbage collection!
            self.image_label.image = self.photo_image
        except Exception as e:
            # Configure the label to show an error message
            self.image_label.config(text=f"Could not load image:\n{screenshot_path}\n{e}", foreground="red")
       
        # Open Screenshot Selector button
        ttk.Button(main_frame, text="Open Screenshot Selector", command=self._get_different_screenshot).grid(row=row, column=2, sticky="w", padx=5, pady=2)
       
        row += 1
        
        # Audio Path
        ttk.Label(main_frame, text="Audio Path:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        ttk.Label(main_frame, text=audio_path if audio_path else "No Audio", wraplength=400, justify="left").grid(row=row, column=1, sticky="w", padx=5, pady=2)
        if audio_path and os.path.isfile(audio_path):
            ttk.Button(main_frame, text="Play Audio", command=lambda: self._play_audio(audio_path)).grid(row=row, column=2, sticky="w", padx=5, pady=2)
            
        row += 1

        # Action Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=row, column=0, columnspan=2, pady=15)
        if audio_path and os.path.isfile(audio_path):
            ttk.Button(button_frame, text="Voice", command=self._on_voice, bootstyle="success").pack(side="left", padx=10)
            ttk.Button(button_frame, text="NO Voice", command=self._on_no_voice, bootstyle="danger").pack(side="left", padx=10)
        else:
            ttk.Button(button_frame, text="Confirm", command=self._on_no_voice, bootstyle="primary").pack(side="left", padx=10)
        
        
    def _get_different_screenshot(self):
        video_path = gsm_state.current_replay
        new_screenshot_path = self.config_app.show_screenshot_selector(
            video_path, self.screenshot_timestamp, mode=get_config().screenshot.screenshot_timing_setting
        )

        # If the user cancels the selector, it might return None or an empty string
        if not new_screenshot_path:
            return

        self.screenshot_path = new_screenshot_path # Update the path to be returned later

        try:
            img = Image.open(self.screenshot_path)
            img.thumbnail((400, 300))
            # Create the new image object
            self.photo_image = ImageTk.PhotoImage(img)

            # <<< CHANGED: Step 2 - Update the label with the new image
            self.image_label.config(image=self.photo_image, text="") # Clear any previous error text
            
            # This is crucial! Keep a reference to the new image object on the widget
            # itself, so it doesn't get garbage-collected.
            self.image_label.image = self.photo_image
        
        except Exception as e:
            # Handle cases where the newly selected file is invalid
            self.image_label.config(image=None, text=f"Could not load new image:\n{e}", foreground="red")
            self.image_label.image = None # Clear old image reference


    def _play_audio(self, audio_path):
        if not os.path.isfile(audio_path):
            print(f"Audio file does not exist: {audio_path}")
            return
        try:
            if platform.system() == "Windows":
                os.startfile(audio_path)
            elif platform.system() == "Darwin":
                subprocess.run(["open", audio_path])
            else:
                subprocess.run(["xdg-open", audio_path])
        except Exception as e:
            print(f"Failed to play audio: {e}")
        
    def _on_voice(self):
        # The screenshot_path is now correctly updated if the user chose a new one
        self.result = (True, self.sentence_text.get("1.0", tk.END).strip(), self.translation_text.get("1.0", tk.END).strip(), self.screenshot_path)
        self.destroy()

    def _on_no_voice(self):
        self.result = (False, self.sentence_text.get("1.0", tk.END).strip(), self.translation_text.get("1.0", tk.END).strip(), self.screenshot_path)
        self.destroy()
        
    def _on_cancel(self):
        # We block the cancel button, but if you wanted to enable it:
        # self.result = None
        # self.destroy()
        pass