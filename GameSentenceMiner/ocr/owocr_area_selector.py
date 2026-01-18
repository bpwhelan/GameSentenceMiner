# import argparse
# import base64
# import ctypes
# import io
# import json
# import sys
# from multiprocessing import Process, Manager
# from pathlib import Path

# from PIL import Image, ImageTk

# # Assuming a mock or real obs module exists in this path
# from GameSentenceMiner import obs
# from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness, get_window, get_scene_ocr_config_path
# from GameSentenceMiner.util.gsm_utils import sanitize_filename
# from GameSentenceMiner.util.configuration import logger

# try:
#     import tkinter as tk
#     from tkinter import font as tkfont  # NEW: Import for better font control

#     selector_available = True
# except ImportError:
#     print("Error: tkinter library not found. GUI selection is unavailable.")
#     selector_available = False

# MIN_RECT_WIDTH = 25
# MIN_RECT_HEIGHT = 25

# COORD_SYSTEM_PERCENTAGE = "percentage"


# class ScreenSelector:
#     def __init__(self, result, window_name, use_window_as_config, use_obs_screenshot=False):
#         if not selector_available:
#             raise RuntimeError("tkinter is not available.")
#         if not window_name and not use_obs_screenshot:
#             raise ValueError("A target window name is required for configuration.")

#         obs.connect_to_obs_sync()
#         self.window_name = window_name
#         self.use_obs_screenshot = use_obs_screenshot
#         self.screenshot_img = None
#         try:
#             import mss
#             self.sct = mss.mss()
#             self.monitors = self.sct.monitors[1:]
#             if not self.monitors:
#                 raise RuntimeError("No monitors found by mss.")
#             for i, monitor in enumerate(self.monitors):
#                 monitor['index'] = i
#         except ImportError:
#             print("Error: mss library not found. Please install it: pip install mss")
#             raise RuntimeError("mss is required for screen selection.")

#         if self.use_obs_screenshot:
#             sources = obs.get_active_video_sources()
#             best_source = obs.get_best_source_for_screenshot()
#             if len(sources) > 1:
#                 logger.warning(f"Warning: Multiple active video sources found in OBS. Using '{best_source.get('sourceName')}' for screenshot. Please ensure only one source is active for best results.")
#             self.screenshot_img = obs.get_screenshot_PIL(compression=100, img_format='jpg')
#             # print(screenshot_base64)
#             if not self.screenshot_img:
#                 raise RuntimeError("Failed to get OBS screenshot.")
#             try:
#                 # Scale image to 1280x720
#                 self.screenshot_img = self.screenshot_img.resize(self.scale_down_width_height(self.screenshot_img.width, self.screenshot_img.height), Image.LANCZOS)
#             except Exception as e:
#                 raise RuntimeError(f"Failed to decode or open OBS screenshot: {e}")

#             self.target_window = None
#             self.target_window_geometry = {
#                 "left": 0, "top": 0,
#                 "width": self.screenshot_img.width,
#                 "height": self.screenshot_img.height
#             }
#             print(f"OBS Screenshot dimensions: {self.target_window_geometry}")
#         else:
#             import pygetwindow as gw
#             if not gw:
#                 raise RuntimeError("pygetwindow is not available for window selection.")
#             print(f"Targeting window: '{window_name}'")
#             self.target_window = self._find_target_window()
#             self.target_window_geometry = self._get_window_geometry(self.target_window)
#             if not self.target_window_geometry:
#                 raise RuntimeError(f"Could not find or get geometry for window '{self.window_name}'.")
#             print(f"Found target window at: {self.target_window_geometry}")

#         self.root = None
#         self.scene = ''
#         self.use_window_as_config = use_window_as_config
#         self.result = result
#         self.rectangles = []  # Internal storage is ALWAYS absolute pixels for drawing
#         self.drawn_rect_ids = []
#         self.current_rect_id = None
#         self.start_x = self.start_y = None
#         self.image_mode = True
#         self.redo_stack = []
#         self.bounding_box = {}  # Geometry of the single large canvas window
#         self.instructions_showing = True

#         self.canvas = None
#         self.window = None
#         self.instructions_widget = None
#         self.instructions_window_id = None

#         self.load_existing_rectangles()
        
#     def scale_down_width_height(self, width, height):
#         if width == 0 or height == 0:
#             return width, height
#         aspect_ratio = width / height
#         if aspect_ratio > 2.66:
#             # Ultra-wide (32:9) - use 1920x540
#             return 1920, 540
#         elif aspect_ratio > 2.33:
#             # 21:9 - use 1920x800
#             return 1920, 800
#         elif aspect_ratio > 1.77:
#             # 16:9 - use 1280x720
#             return 1280, 720
#         elif aspect_ratio > 1.6:
#             # 16:10 - use 1280x800
#             return 1280, 800
#         elif aspect_ratio > 1.33:
#             # 4:3 - use 960x720
#             return 960, 720
#         elif aspect_ratio > 1.25:
#             # 5:4 - use 900x720
#             return 900, 720
#         elif aspect_ratio > 1.5:
#             # 3:2 - use 1080x720
#             return 1080, 720
#         else:
#             # Default/fallback - use original resolution
#             print(f"Unrecognized aspect ratio {aspect_ratio}. Using original resolution.")
#             return width, height

#     def _find_target_window(self):
#         try:
#             return get_window(self.window_name)
#         except Exception as e:
#             print(f"Error finding window '{self.window_name}': {e}")
#             return None

#     def _get_window_geometry(self, window):
#         if window:
#             try:
#                 # Ensure width/height are positive and non-zero
#                 width = max(1, window.width)
#                 height = max(1, window.height)
#                 return {"left": window.left, "top": window.top, "width": width, "height": height}
#             except Exception:
#                 return None
#         return None

#     def load_existing_rectangles(self):
#         """Loads rectangles from config, converting from percentage to absolute pixels for use."""
#         config_path = get_scene_ocr_config_path(self.use_window_as_config, self.window_name)
#         win_geom = self.target_window_geometry  # Use current geometry for conversion
#         win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']

#         try:
#             with open(config_path, 'r', encoding='utf-8') as f:
#                 config_data = json.load(f)

#             if config_data.get("coordinate_system") != COORD_SYSTEM_PERCENTAGE:
#                 print(
#                     f"Warning: Config file '{config_path}' does not use '{COORD_SYSTEM_PERCENTAGE}' system. Please re-create selections.")
#                 return

#             print(f"Loading rectangles from {config_path}...")
#             self.rectangles = []
#             loaded_count = 0

#             for rect_data in config_data.get("rectangles", []):
#                 try:
#                     coords_pct = rect_data["coordinates"]
#                     x_pct, y_pct, w_pct, h_pct = map(float, coords_pct)

#                     # Convert from percentage to absolute pixel coordinates
#                     x_abs = (x_pct * win_w) + win_l
#                     y_abs = (y_pct * win_h) + win_t
#                     w_abs = w_pct * win_w
#                     h_abs = h_pct * win_h
#                     abs_coords = (int(x_abs), int(y_abs), int(w_abs), int(h_abs))

#                     monitor_index = rect_data["monitor"]['index']
#                     target_monitor = next((m for m in self.monitors if m['index'] == monitor_index), None)
#                     if target_monitor:
#                         self.rectangles.append((target_monitor, abs_coords, rect_data["is_excluded"], rect_data.get("is_secondary", False)))
#                         loaded_count += 1
#                 except (KeyError, ValueError, TypeError) as e:
#                     print(f"Skipping malformed rectangle data: {rect_data}, Error: {e}")

#             print(f"Loaded {loaded_count} valid rectangles.")
#         except FileNotFoundError:
#             print(f"No config found at {config_path}. Starting fresh.")
#         except Exception as e:
#             print(f"Error loading config: {e}. Starting fresh.")

#     def save_rects(self, event=None):
#         """Saves rectangles to config, converting from absolute pixels to percentages."""
#         config_path = get_scene_ocr_config_path(self.use_window_as_config, self.window_name)
#         win_geom = self.target_window_geometry
#         win_l, win_t, win_w, win_h = win_geom['left'], win_geom['top'], win_geom['width'], win_geom['height']
#         print(f"Saving rectangles to: {config_path} relative to window: {win_geom}")

#         serializable_rects = []
#         for monitor_dict, abs_coords, is_excluded, is_secondary in self.rectangles:
#             x_abs, y_abs, w_abs, h_abs = abs_coords

#             # Convert absolute pixel coordinates to percentages
#             x_pct = (x_abs - win_l) / win_w
#             y_pct = (y_abs - win_t) / win_h
#             w_pct = w_abs / win_w
#             h_pct = h_abs / win_h
#             coords_to_save = [x_pct, y_pct, w_pct, h_pct]

#             serializable_rects.append({
#                 "monitor": {'index': monitor_dict['index']},
#                 "coordinates": coords_to_save,
#                 "is_excluded": is_excluded,
#                 "is_secondary": is_secondary
#             })

#         save_data = {
#             "scene": self.scene or "",
#             "window": self.window_name,
#             "coordinate_system": COORD_SYSTEM_PERCENTAGE,  # Always save as percentage
#             "window_geometry": win_geom,  # Save the geometry used for conversion
#             "rectangles": serializable_rects
#         }

#         with open(config_path, 'w', encoding="utf-8") as f:
#             json.dump(save_data, f, indent=4, ensure_ascii=False)

#         print(f"Successfully saved {len(serializable_rects)} rectangles.")
#         # Pass back the internal absolute coords for any immediate post-processing
#         self.result['rectangles'] = [(r[0], list(r[1]), r[2]) for r in self.rectangles]
#         self.result['window_geometry'] = win_geom
#         self.result['coordinate_system'] = COORD_SYSTEM_PERCENTAGE
#         self.quit_app()

#     def undo_last_rect(self, event=None):
#         if self.rectangles and self.drawn_rect_ids:
#             last_rect_tuple = self.rectangles.pop()
#             last_rect_id = self.drawn_rect_ids.pop()
#             self.redo_stack.append((*last_rect_tuple, last_rect_id))
#             event.widget.winfo_toplevel().winfo_children()[0].delete(last_rect_id)
#             print("Undo: Removed last rectangle.")

#     def toggle_image_mode(self, e=None):
#         self.image_mode = not self.image_mode
#         # Only change alpha of the main window, not the text widget
#         self.window.attributes("-alpha", 1.0 if self.image_mode else 0.25)
#         print("Toggled background visibility.")

#     def redo_last_rect(self, event=None):
#         if not self.redo_stack: return
#         monitor, abs_coords, is_excluded, is_secondary, old_rect_id = self.redo_stack.pop()
#         canvas = event.widget.winfo_toplevel().winfo_children()[0]
#         x_abs, y_abs, w_abs, h_abs = abs_coords
#         canvas_x, canvas_y = x_abs - self.bounding_box['left'], y_abs - self.bounding_box['top']
#         outline_color = 'purple' if is_secondary else ('orange' if is_excluded else 'green')
#         new_rect_id = canvas.create_rectangle(canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
#                                               outline=outline_color, width=2)
#         self.rectangles.append((monitor, abs_coords, is_excluded, is_secondary))
#         self.drawn_rect_ids.append(new_rect_id)
#         print("Redo: Restored rectangle.")

#     # --- NEW METHOD TO DISPLAY INSTRUCTIONS ---
#     def _create_instructions_widget(self, parent_canvas):
#         """Creates a separate, persistent window for instructions and control buttons."""
#         if self.instructions_widget and self.instructions_widget.winfo_exists():
#             self.instructions_widget.lift()
#             return

#         self.instructions_widget = tk.Toplevel(parent_canvas)
#         self.instructions_widget.title("Controls")

#         # --- Position it near the main window ---
#         parent_window = parent_canvas.winfo_toplevel()
#         # Make the instructions window transient to the main window to keep it on top
#         # self.instructions_widget.transient(parent_window)
#         self.instructions_widget.attributes('-topmost', 1)
#         # parent_window.update_idletasks()  # Ensure dimensions are up-to-date
#         pos_x = parent_window.winfo_x() + 50
#         pos_y = parent_window.winfo_y() + 50
#         self.instructions_widget.geometry(f"+{pos_x}+{pos_y}")
        
#         main_frame = tk.Frame(self.instructions_widget, padx=10, pady=10)
#         main_frame.pack(fill=tk.BOTH, expand=True)

#         instructions_text = (
#             "How to Use:\n"
#             "• Left Click + Drag: Create a capture area (green).\n"
#             "• Shift + Left Click + Drag: Create an exclusion area (orange).\n"
#             "• Ctrl + Left Click + Drag: Create a secondary (menu) area (purple).\n"
#             "• Right-Click on a box: Delete it."
#         )
#         tk.Label(main_frame, text=instructions_text, justify=tk.LEFT, anchor="w").pack(pady=(0, 10), fill=tk.X)

#         button_frame = tk.Frame(main_frame)
#         button_frame.pack(fill=tk.X, pady=5)

#         def canvas_event_wrapper(func):
#             class MockEvent:
#                 def __init__(self, widget):
#                     self.widget = widget
#             return lambda: func(MockEvent(self.canvas))

#         def root_event_wrapper(func):
#             return lambda: func(None)

#         tk.Button(button_frame, text="Save and Quit (Ctrl+S)", command=root_event_wrapper(self.save_rects)).pack(fill=tk.X, pady=2)
#         tk.Button(button_frame, text="Undo (Ctrl+Z)", command=canvas_event_wrapper(self.undo_last_rect)).pack(fill=tk.X, pady=2)
#         tk.Button(button_frame, text="Redo (Ctrl+Y)", command=canvas_event_wrapper(self.redo_last_rect)).pack(fill=tk.X, pady=2)
#         tk.Button(button_frame, text="Toggle Background (M)", command=root_event_wrapper(self.toggle_image_mode)).pack(fill=tk.X, pady=2)
#         tk.Button(button_frame, text="Quit without Saving (Esc)", command=root_event_wrapper(self.quit_app)).pack(fill=tk.X, pady=2)
#         tk.Button(button_frame, text="Toggle Instructions (I)", command=canvas_event_wrapper(self.toggle_instructions)).pack(fill=tk.X, pady=2)

#         # hotkeys_text = "\n• I: Toggle this instruction panel"
#         # tk.Label(main_frame, text=hotkeys_text, justify=tk.LEFT, anchor="w").pack(pady=(10, 0), fill=tk.X)


#     # --- NEW METHOD TO DISPLAY INSTRUCTIONS ---
#     def print_instructions_box(self, canvas):
#         """Creates a separate, persistent window for instructions and control buttons."""
#         instructions_text = (
#             "How to Use:\n"
#             "  • Left Click + Drag: Create a capture area (green).\n"
#             "  • Shift + Left Click + Drag: Create an exclusion area (orange).\n"
#             "  • Ctrl + Left Click + Drag: Create a secondary (menu) area (purple).\n"
#             "  • Right-Click on a box: Delete it.\n\n"
#             "Hotkeys:\n"
#             "  • Ctrl + S: Save and Quit\n"
#             "  • Ctrl + Z / Ctrl + Y: Undo / Redo\n"
#             "  • M: Toggle background visibility\n"
#             "  • I: Toggle these instructions\n"
#             "  • Esc: Quit without saving"
#             "  "
#         )

#         # Use a common, readable font
#         instruction_font = tkfont.Font(family="Segoe UI", size=10, weight="normal")

#         # Create the text item first to get its size
#         self.instructions_overlay = canvas.create_text(
#             20, 20,  # Position with a small margin
#             text=instructions_text,
#             anchor=tk.NW,
#             fill='white',
#             font=instruction_font,
#             justify=tk.LEFT
#         )

#         # Get the bounding box of the text to draw a background
#         text_bbox = canvas.bbox(self.instructions_overlay)

#         # Create a background rectangle with padding
#         self.instructions_rect = canvas.create_rectangle(
#             text_bbox[0] - 10,  # left
#             text_bbox[1] - 10,  # top
#             text_bbox[2] + 10,  # right
#             text_bbox[3] + 10,  # bottom
#             fill='#2B2B2B',  # Dark, semi-opaque background
#             outline='white',
#             width=1
#         )

#         # Lower the rectangle so it's behind the text
#         canvas.tag_lower(self.instructions_rect, self.instructions_overlay)
        
#         # Add hover effect: make rectangle transparent on mouse over
#         def on_motion(event):
#             # Check if mouse is over the rectangle
#             x, y = event.x, event.y
#             rect_bbox = canvas.bbox(self.instructions_rect)
#             if rect_bbox and rect_bbox[0] <= x <= rect_bbox[2] and rect_bbox[1] <= y <= y <= rect_bbox[3]:
#                 # Set fill to more transparent using denser stipple
#                 canvas.itemconfigure(self.instructions_rect, fill='#2B2B2B', stipple='gray12')
#                 # Make text more transparent by changing its color to a lighter gray
#                 canvas.itemconfigure(self.instructions_overlay, fill='#CCCCCC')
#             else:
#                 # Restore solid fill and opaque text
#                 canvas.itemconfigure(self.instructions_rect, fill='#2B2B2B', stipple='')
#                 canvas.itemconfigure(self.instructions_overlay, fill='white')

#         canvas.bind('<Motion>', on_motion)
        

#     def toggle_instructions(self, event=None):
#         canvas = event.widget.winfo_toplevel().winfo_children()[0]
#         for element in [self.instructions_overlay, self.instructions_rect]:
#             current_state = canvas.itemcget(element, 'state')
#             new_state = tk.NORMAL if current_state == tk.HIDDEN else tk.HIDDEN
#             canvas.itemconfigure(element, state=new_state)
        
#         # if self.instructions_showing:
#         #     self.instructions_widget.withdraw()
#         #     logger.info(f"Toggled instructions visibility: OFF")
#         #     self.instructions_showing = False
#         # else:
#         #     self.instructions_widget.deiconify()
#         #     self.instructions_widget.lift()
#         #     self.canvas.focus_set()
#         #     self.instructions_widget.update_idletasks()  # Ensure it is fully rendered
#         #     logger.info("Toggled instructions visibility: ON")
#         #     self.instructions_showing = True

#     def start(self):
#         self.root = tk.Tk()
#         self.root.withdraw()

#         if self.use_obs_screenshot:
#             # Use the pre-loaded OBS screenshot
#             img = self.screenshot_img
#             self.bounding_box = self.target_window_geometry
#             # Center the window on the primary monitor
#             primary_monitor = self.sct.monitors[1] if len(self.sct.monitors) > 1 else self.sct.monitors[0]
#             win_x = primary_monitor['left'] + (primary_monitor['width'] - img.width) // 2
#             win_y = primary_monitor['top'] + (primary_monitor['height'] - img.height) // 2
#             window_geometry = f"{img.width}x{img.height}+{int(win_x)}+{int(win_y)}"
#         else:
#             # Calculate bounding box of all monitors for the overlay
#             left = min(m['left'] for m in self.monitors)
#             top = min(m['top'] for m in self.monitors)
#             right = max(m['left'] + m['width'] for m in self.monitors)
#             bottom = max(m['top'] + m['height'] for m in self.monitors)
#             self.bounding_box = {'left': left, 'top': top, 'width': right - left, 'height': bottom - top}

#             # Capture the entire desktop area covered by all monitors
#             sct_img = self.sct.grab(self.bounding_box)
#             img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
#             window_geometry = f"{self.bounding_box['width']}x{self.bounding_box['height']}+{left}+{top}"

#         self.window = tk.Toplevel(self.root)
#         self.window.geometry(window_geometry)
#         self.window.overrideredirect(1)
#         self.window.attributes('-topmost', 1)

#         self.photo_image = ImageTk.PhotoImage(img)
#         self.canvas = tk.Canvas(self.window, cursor='cross', highlightthickness=0)
#         self.canvas.pack(fill=tk.BOTH, expand=True)
#         self.canvas.create_image(0, 0, image=self.photo_image, anchor=tk.NW)

#         # --- MODIFIED: CALL THE INSTRUCTION WIDGET CREATOR ---
#         # self._create_instructions_widget(self.canvas)
#         # --- END MODIFICATION ---

#         # Draw existing rectangles (which were converted to absolute pixels on load)
#         for _, abs_coords, is_excluded, is_secondary in self.rectangles:
#             x_abs, y_abs, w_abs, h_abs = abs_coords
#             canvas_x = x_abs - self.bounding_box['left']
#             canvas_y = y_abs - self.bounding_box['top']
#             outline_color = 'purple' if is_secondary else ('orange' if is_excluded else 'green')
#             rect_id = self.canvas.create_rectangle(canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
#                                               outline=outline_color, width=2)
#             self.drawn_rect_ids.append(rect_id)

#         def on_click(event):
#             self.start_x, self.start_y = event.x, event.y
#             ctrl_held = bool(event.state & 0x0004)
#             shift_held = bool(event.state & 0x0001)
#             if ctrl_held:
#                 outline = 'purple'
#             elif shift_held:
#                 outline = 'orange'
#             else:
#                 outline = 'green'
#             self.current_rect_id = self.canvas.create_rectangle(self.start_x, self.start_y, self.start_x, self.start_y,
#                                                            outline=outline, width=2)

#         def on_drag(event):
#             if self.current_rect_id: self.canvas.coords(self.current_rect_id, self.start_x, self.start_y, event.x, event.y)

#         def on_release(event):
#             if not self.current_rect_id: return
#             coords = self.canvas.coords(self.current_rect_id)
#             x_abs = int(min(coords[0], coords[2]) + self.bounding_box['left'])
#             y_abs = int(min(coords[1], coords[3]) + self.bounding_box['top'])
#             w, h = int(abs(coords[2] - coords[0])), int(abs(coords[3] - coords[1]))

#             if w >= MIN_RECT_WIDTH and h >= MIN_RECT_HEIGHT:
#                 ctrl_held = bool(event.state & 0x0004)
#                 shift_held = bool(event.state & 0x0001)
#                 is_excl = shift_held
#                 is_secondary = ctrl_held
#                 outline_color = 'purple' if is_secondary else ('orange' if is_excl else 'green')
#                 self.canvas.itemconfig(self.current_rect_id, outline=outline_color)

#                 center_x, center_y = x_abs + w / 2, y_abs + h / 2
#                 target_mon = self.monitors[0]
#                 for mon in self.monitors:
#                     if mon['left'] <= center_x < mon['left'] + mon['width'] and mon['top'] <= center_y < mon['top'] + \
#                             mon['height']:
#                         target_mon = mon
#                         break

#                 self.rectangles.append((target_mon, (x_abs, y_abs, w, h), is_excl, is_secondary))
#                 self.drawn_rect_ids.append(self.current_rect_id)
#                 self.redo_stack.clear()
#             else:
#                 self.canvas.delete(self.current_rect_id)
#             self.current_rect_id = self.start_x = self.start_y = None

#         def on_right_click(event):
#             # Iterate through our rectangles in reverse to find the topmost one.
#             for i in range(len(self.rectangles) - 1, -1, -1):
#                 _monitor, abs_coords, _is_excluded, _is_secondary = self.rectangles[i]
#                 x_abs, y_abs, w_abs, h_abs = abs_coords
#                 canvas_x1 = x_abs - self.bounding_box['left']
#                 canvas_y1 = y_abs - self.bounding_box['top']
#                 canvas_x2 = canvas_x1 + w_abs
#                 canvas_y2 = canvas_y1 + h_abs

#                 if canvas_x1 <= event.x <= canvas_x2 and canvas_y1 <= event.y <= canvas_y2:
#                     # --- UNDO/REDO CHANGE ---
#                     # We found the rectangle. Prepare the 'remove' action.
#                     # We need to save the data AND its original index to restore it correctly.
#                     rect_tuple_to_del = self.rectangles[i]
#                     item_id_to_del = self.drawn_rect_ids[i]

#                     self.redo_stack.append((*rect_tuple_to_del, i))

#                     # Now, perform the deletion
#                     del self.rectangles[i]
#                     del self.drawn_rect_ids[i]
#                     self.canvas.delete(item_id_to_del)
#                     print("Deleted rectangle.")

#                     break  # Stop after deleting the topmost one

#         def on_enter(e=None):
#             self.canvas.focus_set()

#         self.canvas.bind('<Enter>', on_enter)
#         self.canvas.bind('<ButtonPress-1>', on_click)
#         self.canvas.bind('<B1-Motion>', on_drag)
#         self.canvas.bind('<ButtonRelease-1>', on_release)
#         self.canvas.bind('<Button-3>', on_right_click)
#         self.canvas.bind('<Control-s>', self.save_rects)
#         self.canvas.bind('<Control-y>', self.redo_last_rect)
#         self.canvas.bind('<Control-z>', self.undo_last_rect)
#         self.canvas.bind("<Escape>", self.quit_app)
#         self.canvas.bind("<m>", self.toggle_image_mode)
#         self.canvas.bind("<i>", self.toggle_instructions)

#         self.canvas.focus_set()
#         self._create_instructions_widget(self.window)
#         self.window.winfo_toplevel().update_idletasks()
#         self.print_instructions_box(self.canvas)
#         # The print message is now redundant but kept for console feedback
#         print("Starting UI. See on-screen instructions. Press Esc to quit, Ctrl+S to save.")
#         # self.canvas.update_idletasks()
#         self.root.mainloop()

#     def quit_app(self, event=None):
#         if self.instructions_widget and self.instructions_widget.winfo_exists():
#             self.instructions_widget.destroy()
#         if self.root and self.root.winfo_exists(): self.root.destroy()
#         self.root = None


# def run_screen_selector(result_dict, window_name, use_window_as_config, use_obs_screenshot):
#     try:
#         selector = ScreenSelector(result_dict, window_name, use_window_as_config, use_obs_screenshot)
#         selector.start()
#     except Exception as e:
#         print(f"Error in selector process: {e}", file=sys.stderr)
#         import traceback
#         traceback.print_exc()
#         result_dict['error'] = str(e)


# def get_screen_selection(window_name, use_window_as_config=False, use_obs_screenshot=False):
#     if not selector_available: return None
#     if not window_name and not use_obs_screenshot:
#         print("Error: A target window name must be provided.", file=sys.stderr)
#         return None

#     with Manager() as manager:
#         result_data = manager.dict()
#         process = Process(target=run_screen_selector, args=(result_data, window_name, use_window_as_config, use_obs_screenshot))
#         print(f"Starting ScreenSelector process...")
#         process.start()
#         process.join()

#         if 'error' in result_data:
#             print(f"Selector process failed: {result_data['error']}", file=sys.stderr)
#             return None
#         elif 'rectangles' in result_data:
#             print("Screen selection successful.")
#             return dict(result_data)
#         else:
#             print("Selection was cancelled by the user.")
#             return {}


# if __name__ == "__main__":
#     set_dpi_awareness()

#     parser = argparse.ArgumentParser(description="Screen Selector Arguments")
#     parser.add_argument("window_title", nargs="?", default="", help="Target window title")
#     parser.add_argument("--obs", action="store_true", default=True, help="Use OBS screenshot")
#     parser.add_argument("--use_window_for_config", action="store_true", help="Use window for config")
#     args = parser.parse_args()

#     target_window_title = args.window_title
#     use_obs_screenshot = args.obs
#     use_window_as_config = args.use_window_for_config

#     print(f"Arguments: Window Title='{target_window_title}', Use OBS Screenshot={use_obs_screenshot}, Use Window for Config={use_window_as_config}")

#     # Example of how to call it
#     selection_result = get_screen_selection(target_window_title, use_window_as_config, use_obs_screenshot)

#     if selection_result is None:
#         print("--- Screen selection failed. ---")
#     elif not selection_result:
#         print("\n--- Screen selection cancelled. ---")
#     elif 'rectangles' in selection_result:
#         print("\n--- Selection Result ---")
#         rects = selection_result.get('rectangles', [])
#         win_geom = selection_result.get('window_geometry')
#         print(f"Saved relative to window: {win_geom}")
#         print(f"Selected rectangles ({len(rects)}):")
#         # The returned coordinates are absolute pixels for immediate use
#         for i, (monitor, coords, is_excluded) in enumerate(rects):
#             coord_str = f"(X:{coords[0]}, Y:{coords[1]}, W:{coords[2]}, H:{coords[3]})"
#             print(
#                 f"  Rect {i + 1}: On Monitor Idx:{monitor.get('index', 'N/A')}, Coords={coord_str}, Excluded={is_excluded}")