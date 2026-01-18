# import math
# import os
# import re
# import subprocess
# import json
# import tkinter as tk
# from tkinter import messagebox
# import ttkbootstrap as ttk
# from PIL import Image, ImageTk

# from GameSentenceMiner.util import ffmpeg
# from GameSentenceMiner.util.gsm_utils import sanitize_filename
# from GameSentenceMiner.util.configuration import get_config, get_temporary_directory, logger, ffmpeg_base_command_list, get_ffprobe_path, ffmpeg_base_command_list_info


# class ScreenshotSelectorDialog(tk.Toplevel):
#     """
#     A modal dialog that extracts frames from a video around a specific timestamp
#     and allows the user to select the best one.
#     """
#     def __init__(self, parent, config_app, video_path, timestamp, mode='beginning'):
#         super().__init__(parent)
#         self.config_app = config_app

#         self.title("Select Screenshot")
#         self.configure(bg="black")
#         self.selected_path = None # This will store the final result
#         self.parent_window = parent # Store a reference to the parent

#         # Handle the user closing the window with the 'X' button
#         self.protocol("WM_DELETE_WINDOW", self._on_cancel)

#         # Make the dialog modal
#         self.grab_set()

#         # --- Show a loading message while ffmpeg runs ---
#         self.loading_label = ttk.Label(
#             self,
#             text="Extracting frames, please wait...",
#             bootstyle="inverse-primary",
#             font=("Helvetica", 16)
#         )
#         self.loading_label.pack(pady=50, padx=50)
#         self.update() # Force the UI to update and show the label

#         # --- Run extraction and build the main UI ---
#         try:
#             image_paths, golden_frame = self._extract_frames(video_path, timestamp, mode)
#             self.loading_label.destroy() # Remove the loading message

#             if not image_paths:
#                 messagebox.showerror("Error", "Failed to extract frames from the video.", parent=self)
#                 self.destroy()
#                 return

#             self._build_image_grid(image_paths, golden_frame)

#         except Exception as e:
#             logger.error(f"ScreenshotSelector failed: {e}")
#             messagebox.showerror("Error", f"An unexpected error occurred: {e}", parent=self)
#             self.destroy()
#             return

#         # --- Center the dialog and wait for it to close ---
#         self._center_window()
#         self.attributes('-topmost', True)
#         self.wait_window(self)
#         # Force always on top to ensure visibility

#     def _extract_frames(self, video_path, timestamp, mode):
#         """Extracts frames using ffmpeg, with automatic black bar removal."""
#         temp_dir = os.path.join(
#             get_temporary_directory(False),
#             "screenshot_frames",
#             sanitize_filename(os.path.splitext(os.path.basename(video_path))[0])
#         )
#         os.makedirs(temp_dir, exist_ok=True)

#         frame_paths = []
#         golden_frame = None
#         timestamp_number = float(timestamp)
#         video_duration = self.get_video_duration(video_path)

#         if mode == 'middle':
#             timestamp_number = max(0.0, timestamp_number - 2.5)
#         elif mode == 'end':
#             timestamp_number = max(0.0, timestamp_number - 5.0)

#         if video_duration is not None and timestamp_number > video_duration:
#             logger.warning(f"Timestamp {timestamp_number} exceeds video duration {video_duration}.")
#             return [], None

#         video_filters = []

#         if get_config().screenshot.trim_black_bars_wip:
#             crop_filter = ffmpeg.find_black_bars(video_path, timestamp_number)
#             if crop_filter:
#                 video_filters.append(crop_filter)

#         # Always add the frame extraction filter
#         video_filters.append(f"fps=1/{0.25}")

#         try:
#             # Build the final command for frame extraction
#             command = ffmpeg_base_command_list + [
#                 "-y",                          # Overwrite output files without asking
#                 "-ss", str(timestamp_number),
#                 "-i", video_path
#             ]
            
#             # Chain all collected filters (crop and fps) together with a comma
#             command.extend(["-vf", ",".join(video_filters)])
            
#             command.extend([
#                 "-vframes", "20",
#                 os.path.join(temp_dir, "frame_%02d.png")
#             ])
            
#             logger.debug(f"Executing frame extraction command: {' '.join(command)}")
#             subprocess.run(command, check=True, capture_output=True, text=True)

#             # The rest of your logic remains the same
#             for i in range(1, 21):
#                 frame_path = os.path.join(temp_dir, f"frame_{i:02d}.png")
#                 if os.path.exists(frame_path):
#                     frame_paths.append(frame_path)

#             if not frame_paths: return [], None

#             if mode == "beginning":
#                 golden_frame = frame_paths[0] if frame_paths else None
#             elif mode == "middle":
#                 golden_frame = frame_paths[len(frame_paths) // 2] if frame_paths else None
#             elif mode == "end":
#                 golden_frame = frame_paths[-1] if frame_paths else None

#             return frame_paths, golden_frame

#         except subprocess.CalledProcessError as e:
#             logger.error(f"Error extracting frames: {e}")
#             logger.error(f"FFmpeg command was: {' '.join(command)}")
#             logger.error(f"FFmpeg output:\n{e.stderr}")
#             return [], None
#         except Exception as e:
#             logger.error(f"An unexpected error occurred during frame extraction: {e}")
#             return [], None
        
#     def _build_image_grid(self, image_paths, golden_frame):
#         """Creates and displays the grid of selectable images."""
#         self.images = [] # Keep a reference to images to prevent garbage collection
#         max_cols = 5
#         for i, path in enumerate(image_paths):
#             try:
#                 img = Image.open(path)
#                 # Use a larger thumbnail size for better visibility
#                 # Making this division-based can be risky if images are very small
#                 # Let's use a fixed thumbnail size for robustness
#                 img.thumbnail((256, 144))
#                 img_tk = ImageTk.PhotoImage(img)
#                 self.images.append(img_tk)

#                 is_golden = (path == golden_frame)
#                 border_width = 4 if is_golden else 2
#                 border_color = "gold" if is_golden else "grey"
                
#                 # Using a Frame for better border control
#                 frame = tk.Frame(self, bg=border_color, borderwidth=border_width, relief="solid")
#                 frame.grid(row=i // max_cols, column=i % max_cols, padx=3, pady=3)

#                 label = tk.Label(frame, image=img_tk, borderwidth=0, bg="black")
#                 label.pack()

#                 # Bind the click event to both the frame and the label for better UX
#                 frame.bind("<Button-1>", lambda e, p=path: self._on_image_click(p))
#                 label.bind("<Button-1>", lambda e, p=path: self._on_image_click(p))

#             except Exception as e:
#                 logger.error(f"Could not load image {path}: {e}")
#                 error_label = ttk.Label(self, text="Load Error", bootstyle="inverse-danger", width=30, anchor="center")
#                 error_label.grid(row=i // max_cols, column=i % max_cols, padx=3, pady=3, ipadx=10, ipady=50)

#     def _on_image_click(self, path):
#         """Handles a user clicking on an image."""
#         self.selected_path = path
#         self.destroy()

#     def _on_cancel(self):
#         """Handles the user closing the window without a selection."""
#         self.selected_path = None
#         self.destroy()

#     def _center_window(self):
#         """
#         Centers the dialog on the screen regardless of parent state.
#         """
#         self.update_idletasks()
        
#         dialog_width = self.winfo_width()
#         dialog_height = self.winfo_height()
#         screen_width = self.winfo_screenwidth()
#         screen_height = self.winfo_screenheight()
        
#         x = (screen_width // 2) - (dialog_width // 2)
#         y = (screen_height // 2) - (dialog_height // 2)
        
#         self.geometry(f'+{x}+{y}')

#     def get_video_duration(self, file_path):
#         try:
#             ffprobe_command = [
#                 f"{get_ffprobe_path()}",
#                 "-v", "error",
#                 "-show_entries", "format=duration",
#                 "-of", "json",
#                 file_path
#             ]
#             logger.debug(" ".join(ffprobe_command))
#             result = subprocess.run(ffprobe_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
#             duration_info = json.loads(result.stdout)
#             logger.debug(f"Video duration: {duration_info}")
#             return float(duration_info["format"]["duration"])
#         except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, FileNotFoundError) as e:
#             logger.error(f"Failed to get video duration for {file_path}: {e}")
#             return None