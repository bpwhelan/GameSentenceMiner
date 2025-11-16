# import tkinter as tk
# from tkinter import scrolledtext
# from tkinter import messagebox
# from PIL import Image, ImageTk

# import ttkbootstrap as ttk
# from GameSentenceMiner.util.configuration import get_config, logger, gsm_state, get_temporary_directory
# from GameSentenceMiner.util.audio_player import AudioPlayer
# from GameSentenceMiner.util.gsm_utils import make_unique_file_name

# import platform
# import subprocess
# import os
# import requests
# from urllib.parse import quote

# class AnkiConfirmationDialog(tk.Toplevel):
#     """
#     A modal dialog to confirm Anki card details and choose an audio option.
#     """
#     def __init__(self, parent, config_app, expression, sentence, screenshot_path, audio_path, translation, screenshot_timestamp):
#         super().__init__(parent)
#         self.config_app = config_app
#         self.screenshot_timestamp = screenshot_timestamp
#         self.translation_text = None
#         self.sentence_text = None
#         self.sentence = sentence  # Store sentence text for TTS
        
#         # Initialize screenshot_path here, will be updated by button if needed
#         self.screenshot_path = screenshot_path
#         self.audio_path = audio_path  # Store audio path so it can be updated

#         # Audio player management
#         self.audio_player = AudioPlayer(finished_callback=self._audio_finished)
#         self.audio_button = None  # Store reference to audio button
#         self.audio_path_label = None  # Store reference to audio path label
#         self.tts_button = None  # Store reference to TTS button
#         self.tts_status_label = None  # Store reference to TTS status label
        
#         # NSFW tag option
#         self.nsfw_tag_var = tk.BooleanVar(value=False)

#         self.title("Confirm Anki Card Details")
#         self.result = None  # This will store the user's choice

#         # This makes the dialog block interaction with other windows.
#         self.grab_set()

#         # --- Create and lay out widgets ---
#         self._create_widgets(expression, sentence, screenshot_path, audio_path, translation)

#         # --- Center the dialog on screen ---
#         self.update_idletasks()

#         dialog_width = self.winfo_width()
#         dialog_height = self.winfo_height()
#         screen_width = self.winfo_screenwidth()
#         screen_height = self.winfo_screenheight()
        
#         x = (screen_width // 2) - (dialog_width // 2)
#         y = (screen_height // 2) - (dialog_height // 2)
#         self.geometry(f'+{x}+{y}')

#         self.protocol("WM_DELETE_WINDOW", self._on_cancel)
#         self.attributes('-topmost', True)
        
#         # Ensure audio cleanup on window close
#         self.protocol("WM_DELETE_WINDOW", self._cleanup_and_close)
        
#         self.wait_window(self)

#     def _create_widgets(self, expression, sentence, screenshot_path, audio_path, translation):
#         main_frame = ttk.Frame(self, padding=20)
#         main_frame.pack(expand=True, fill="both")

#         row = 0

#         # Expression
#         ttk.Label(main_frame, text=f"{get_config().anki.word_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
#         ttk.Label(main_frame, text=expression, wraplength=400, justify="left").grid(row=row, column=1, sticky="w", padx=5, pady=2)
#         row += 1

#         # Sentence
#         ttk.Label(main_frame, text=f"{get_config().anki.sentence_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
#         sentence_text = scrolledtext.ScrolledText(main_frame, height=4, width=50, wrap=tk.WORD)
#         sentence_text.insert(tk.END, sentence)
#         sentence_text.grid(row=row, column=1, sticky="w", padx=5, pady=2)
#         self.sentence_text = sentence_text
#         row += 1

#         if translation:
#             # Translation
#             ttk.Label(main_frame, text=f"{get_config().ai.anki_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
#             translation_text = scrolledtext.ScrolledText(main_frame, height=4, width=50, wrap=tk.WORD)
#             translation_text.insert(tk.END, translation)
#             translation_text.grid(row=row, column=1, sticky="w", padx=5, pady=2)
#             self.translation_text = translation_text
#             row += 1

#         # Screenshot
#         ttk.Label(main_frame, text=f"{get_config().anki.picture_field}:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
        
#         # <<< CHANGED: Step 1 - Create and store the label for the image
#         self.image_label = ttk.Label(main_frame)
#         self.image_label.grid(row=row, column=1, sticky="w", padx=5, pady=2)
        
#         try:
#             img = Image.open(screenshot_path)
#             img.thumbnail((400, 300))
#             self.photo_image = ImageTk.PhotoImage(img)
#             # Configure the label we just created
#             self.image_label.config(image=self.photo_image)
#             # Keep a reference on the widget itself to prevent garbage collection!
#             self.image_label.image = self.photo_image
#         except Exception as e:
#             # Configure the label to show an error message
#             self.image_label.config(text=f"Could not load image:\n{screenshot_path}\n{e}", foreground="red")
       
#         # Open Screenshot Selector button
#         ttk.Button(main_frame, text="Open Screenshot Selector", command=self._get_different_screenshot).grid(row=row, column=2, sticky="w", padx=5, pady=2)
       
#         row += 1
        
#         # Audio Path
#         if audio_path and os.path.isfile(audio_path):
#             ttk.Label(main_frame, text="Audio Path:", font=("-weight bold")).grid(row=row, column=0, sticky="ne", padx=5, pady=2)
#             self.audio_path_label = ttk.Label(main_frame, text=audio_path if audio_path else "No Audio", wraplength=400, justify="left")
#             self.audio_path_label.grid(row=row, column=1, sticky="w", padx=5, pady=2)
#             if audio_path and os.path.isfile(audio_path):
#                 self.audio_button = ttk.Button(
#                     main_frame,
#                     text="▶",
#                     command=lambda: self._play_audio(self.audio_path),
#                     bootstyle="outline-info",
#                     width=12
#                 )
#                 self.audio_button.grid(row=row, column=2, sticky="w", padx=5, pady=2)

#             row += 1
            
#             # TTS Button - only show if TTS is enabled in config
#             if get_config().vad.use_tts_as_fallback and sentence:
#                 self.tts_button = ttk.Button(
#                     main_frame,
#                     text="🔊 Generate TTS Audio",
#                     command=self._generate_tts_audio,
#                     bootstyle="info",
#                     width=20
#                 )
#                 self.tts_button.grid(row=row, column=1, sticky="w", padx=5, pady=2)
                
#                 # TTS Status Label
#                 self.tts_status_label = ttk.Label(main_frame, text="", foreground="green")
#                 self.tts_status_label.grid(row=row, column=2, sticky="w", padx=5, pady=2)
                
#                 row += 1

#         # NSFW Tag Option
#         nsfw_frame = ttk.Frame(main_frame)
#         nsfw_frame.grid(row=row, column=0, columnspan=2, pady=10)
#         ttk.Checkbutton(
#             nsfw_frame,
#             text="Add NSFW tag?",
#             variable=self.nsfw_tag_var,
#             bootstyle="round-toggle"
#         ).pack(side="left", padx=5)
#         row += 1

#         # Action Buttons
#         button_frame = ttk.Frame(main_frame)
#         button_frame.grid(row=row, column=0, columnspan=2, pady=15)
#         if audio_path and os.path.isfile(audio_path):
#             ttk.Button(button_frame, text="Voice", command=self._on_voice, bootstyle="success").pack(side="left", padx=10)
#             ttk.Button(button_frame, text="NO Voice", command=self._on_no_voice, bootstyle="danger").pack(side="left", padx=10)
#         else:
#             ttk.Button(button_frame, text="Confirm", command=self._on_no_voice, bootstyle="primary").pack(side="left", padx=10)
        
        
#     def _get_different_screenshot(self):
#         from GameSentenceMiner.ui.screenshot_selector_qt import show_screenshot_selector  # from GameSentenceMiner.ui.screenshot_selector import ScreenshotSelectorDialog
#         video_path = gsm_state.current_replay
        
#         def on_screenshot_selected(selected_path):  # from GameSentenceMiner.ui.screenshot_selector: new_screenshot_path = self.config_app.show_screenshot_selector(...)
#             if not selected_path:
#                 return
            
#             self.screenshot_path = selected_path
#             try:
#                 img = Image.open(self.screenshot_path)
#                 img.thumbnail((400, 300))
#                 self.photo_image = ImageTk.PhotoImage(img)
#                 self.image_label.config(image=self.photo_image, text="")
#             except Exception as e:
#                 logger.error(f"Error updating screenshot: {e}")
        
#         show_screenshot_selector(
#             self.config_app,
#             video_path,
#             self.screenshot_timestamp,
#             mode=get_config().screenshot.screenshot_timing_setting,
#             on_complete=on_screenshot_selected
#         )


#     def _play_audio(self, audio_path):
#         if not os.path.isfile(audio_path):
#             print(f"Audio file does not exist: {audio_path}")
#             return
        
#         try:
#             # Check if we have a configuration for external audio player
#             if get_config().advanced.audio_player_path:
#                 # Use external audio player
#                 import platform
#                 import subprocess
#                 if platform.system() == "Windows":
#                     os.startfile(audio_path)
#                 elif platform.system() == "Darwin":
#                     subprocess.run(["open", audio_path])
#                 else:
#                     subprocess.run(["xdg-open", audio_path])
#             else:
#                 # Use internal audio player
#                 success = self.audio_player.play_audio_file(audio_path)
#                 if success:
#                     self._update_audio_button()
                
#         except Exception as e:
#             print(f"Failed to play audio: {e}")
    
#     def _audio_finished(self):
#         """Called when audio playback finishes"""
#         self._update_audio_button()
    
#     def _update_audio_button(self):
#         """Update the audio button text and style based on playing state"""
#         if self.audio_button:
#             if self.audio_player.is_playing:
#                 self.audio_button.config(text="⏹ Stop", bootstyle="outline-warning")
#             else:
#                 self.audio_button.config(text="▶ Play Audio", bootstyle="outline-info")
        
#     def _generate_tts_audio(self):
#         """Generate TTS audio from the sentence text"""
#         try:
#             # Get the current sentence text from the widget
#             sentence_text = self.sentence_text.get("1.0", tk.END).strip()
            
#             if not sentence_text:
#                 messagebox.showerror("TTS Error", "No sentence text available for TTS generation.")
#                 return
            
#             # URL-encode the sentence text
#             encoded_text = quote(sentence_text)
            
#             # Build the TTS URL by replacing $s with the encoded text
#             tts_url = get_config().vad.tts_url.replace("$s", encoded_text)
            
#             logger.info(f"Fetching TTS audio from: {tts_url}")
            
#             # Fetch TTS audio from the URL
#             response = requests.get(tts_url, timeout=10)
            
#             if not response.ok:
#                 error_msg = f"Failed to fetch TTS audio: HTTP {response.status_code}"
#                 logger.error(error_msg)
#                 messagebox.showerror("TTS Error", f"{error_msg}\n\nIs your TTS service running?")
#                 return
            
#             # Save TTS audio to GSM temporary directory with game name
#             game_name = gsm_state.current_game if gsm_state.current_game else "tts"
#             filename = f"{game_name}_tts_audio.opus"
#             tts_audio_path = make_unique_file_name(
#                 os.path.join(get_temporary_directory(), filename)
#             )
#             with open(tts_audio_path, 'wb') as f:
#                 f.write(response.content)
            
#             logger.info(f"TTS audio saved to: {tts_audio_path}")
            
#             # Update the audio path
#             self.audio_path = tts_audio_path
            
#             # Update the audio path label
#             if self.audio_path_label:
#                 self.audio_path_label.config(text=tts_audio_path)
            
#             # Update the audio button command to use the new path
#             if self.audio_button:
#                 self.audio_button.config(command=lambda: self._play_audio(self.audio_path))
            
#             # Update status label to show success
#             if self.tts_status_label:
#                 self.tts_status_label.config(text="✓ TTS Audio Generated", foreground="green")
            
#         except requests.exceptions.Timeout:
#             error_msg = "TTS request timed out. Please check if your TTS service is running."
#             logger.error(error_msg)
#             messagebox.showerror("TTS Error", error_msg)
#         except requests.exceptions.RequestException as e:
#             error_msg = f"Failed to connect to TTS service: {str(e)}"
#             logger.error(error_msg)
#             messagebox.showerror("TTS Error", f"{error_msg}\n\nPlease check your TTS URL configuration.")
#         except Exception as e:
#             error_msg = f"Unexpected error generating TTS: {str(e)}"
#             logger.error(error_msg)
#             messagebox.showerror("TTS Error", error_msg)
    
#     def _cleanup_audio(self):
#         """Clean up audio stream resources"""
#         self.audio_player.cleanup()
    
#     def _cleanup_and_close(self):
#         """Clean up resources and close dialog"""
#         self._cleanup_audio()
#         self._on_cancel()
        
#     def _on_voice(self):
#         # Clean up audio before closing
#         self._cleanup_audio()
#         # The screenshot_path is now correctly updated if the user chose a new one
#         # Include audio_path in the result tuple so TTS audio can be sent to Anki
#         self.result = (True, self.sentence_text.get("1.0", tk.END).strip(), self.translation_text.get("1.0", tk.END).strip() if self.translation_text else None, self.screenshot_path, self.nsfw_tag_var.get(), self.audio_path)
#         self.destroy()

#     def _on_no_voice(self):
#         # Clean up audio before closing
#         self._cleanup_audio()
#         # Include audio_path in the result tuple so TTS audio can be sent to Anki
#         self.result = (False, self.sentence_text.get("1.0", tk.END).strip(), self.translation_text.get("1.0", tk.END).strip() if self.translation_text else None, self.screenshot_path, self.nsfw_tag_var.get(), self.audio_path)
#         self.destroy()
        
#     def _on_cancel(self):
#         # We block the cancel button, but if you wanted to enable it:
#         # self.result = None
#         # self.destroy()
#         pass