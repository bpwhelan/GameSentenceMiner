import ctypes
import json
import sys
from multiprocessing import Process, Manager
from pathlib import Path

import mss
from PIL import Image, ImageTk, ImageDraw

from GameSentenceMiner import obs  # Import your actual obs module
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness
from GameSentenceMiner.util import sanitize_filename  # Import your actual util module

try:
    import pygetwindow as gw
except ImportError:
    print("Error: pygetwindow library not found. Please install it: pip install pygetwindow")
    gw = None  # Handle missing library

try:
    import tkinter as tk

    selector_available = True
except ImportError:
    print("Error: tkinter library not found. GUI selection is unavailable.")
    selector_available = False

MIN_RECT_WIDTH = 25  # Minimum width in pixels
MIN_RECT_HEIGHT = 25  # Minimum height in pixels

# --- Constants for coordinate systems ---
COORD_SYSTEM_ABSOLUTE = "absolute_pixels"
COORD_SYSTEM_RELATIVE = "relative_pixels"  # Kept for potential backward compatibility loading
COORD_SYSTEM_PERCENTAGE = "percentage"


# --- ---

class ScreenSelector:
    def __init__(self, result, window_name):
        if not selector_available:
            raise RuntimeError("tkinter is not available.")
        if not gw:
            raise ImportError("pygetwindow is required but not installed.")

        obs.connect_to_obs_sync()  # Connect to OBS (using mock or real)
        self.window_name = window_name
        print(f"Target window name: {window_name or 'None (Absolute Mode)'}")
        self.sct = mss.mss()
        self.monitors = self.sct.monitors[1:]  # Skip the 'all monitors' entry
        if not self.monitors:  # If only one monitor exists
            if len(self.sct.monitors) >= 1:
                self.monitors = self.sct.monitors[0:1]  # Use the primary monitor entry
            else:
                raise RuntimeError("No monitors found by mss.")
        # Assign index to each monitor dictionary
        for i, monitor in enumerate(self.monitors):
            monitor['index'] = i

        self.root = None
        self.result = result  # Manager dict for results
        # Internal storage ALWAYS uses absolute pixel coordinates
        self.rectangles = []  # List to store (monitor_dict, (abs_x, abs_y, abs_w, abs_h), is_excluded) tuples
        self.drawn_rect_ids = []  # List to store canvas rectangle IDs *per canvas* (needs careful management)
        self.current_rect_id = None
        self.start_x = None  # Canvas coordinates
        self.start_y = None  # Canvas coordinates
        self.canvas_windows = {}  # Dictionary mapping monitor_index -> canvas widget
        self.image_mode = True
        self.monitor_windows = {}  # Stores {'window': tk.Toplevel, 'canvas': tk.Canvas, 'bg_img_id': int} per monitor index
        self.redo_stack = []  # Stores undone actions: (monitor_dict, abs_coords, is_excluded, canvas_id)

        # --- Window Awareness ---
        self.target_window = self._find_target_window()
        self.target_window_geometry = self._get_window_geometry(self.target_window)
        if self.target_window_geometry:
            print(f"Found target window '{self.window_name}' at: {self.target_window_geometry}")
        elif self.window_name:
            print(f"Warning: Could not find window '{self.window_name}'. Coordinates will be absolute.")
        else:
            print("No target window specified. Using absolute coordinates.")
        # --- End Window Awareness ---

        self.load_existing_rectangles()  # Load AFTER finding the window

    def _find_target_window(self):
        """Finds the window matching self.window_name."""
        if not self.window_name:
            return None
        try:
            windows = gw.getWindowsWithTitle(self.window_name)
            if windows:
                if len(windows) > 1:
                    print(f"Warning: Multiple windows found with title '{self.window_name}'. Using the first one.")
                return windows[0]
            else:
                return None
        except Exception as e:
            print(f"Error finding window '{self.window_name}': {e}")
            return None

    def _get_window_geometry(self, window):
        """Gets the geometry (left, top, width, height) of a pygetwindow object."""
        if window:
            try:
                # Ensure width/height are positive. Use max(1, ...) to avoid zero dimensions.
                width = max(1, window.width)
                height = max(1, window.height)
                return {"left": window.left, "top": window.top, "width": width, "height": height}
            except Exception as e:
                print(f"Error getting geometry for window '{window.title}': {e}")
                # Handle specific states gracefully if possible
                try:
                    if window.isMinimized or window.isMaximized:
                        print(f"Window '{window.title}' might be minimized or maximized, geometry may be inaccurate.")
                        # Attempt to get geometry anyway, might work depending on OS/lib version
                        width = max(1, window.width)
                        height = max(1, window.height)
                        return {"left": window.left, "top": window.top, "width": width, "height": height}
                except:  # Catch potential errors accessing window state attributes
                    pass  # Fall through to return None
        return None

    def get_scene_ocr_config(self):
        """Return the path to the OCR config file (scene.json)."""
        app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
        ocr_config_dir = app_dir / "ocr_config"
        ocr_config_dir.mkdir(parents=True, exist_ok=True)
        try:
            # Get scene name (use mock or real OBS)
            current_scene = obs.get_current_scene()
            scene = sanitize_filename(current_scene or "default_scene")
        except Exception as e:
            print(f"Error getting OBS scene: {e}. Using default config name.")
            scene = "default_scene"

        # Use only the scene name for the config file
        config_filename = f"{scene}.json"
        config_path = ocr_config_dir / config_filename
        return config_path

    def load_existing_rectangles(self):
        """Loads rectangles from the config file, converting to absolute pixels."""
        config_path = self.get_scene_ocr_config()
        # Get CURRENT window geometry for potential conversion
        current_window_geometry = self._get_window_geometry(self._find_target_window())

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)

            # --- Determine coordinate system ---
            saved_coord_system = config_data.get("coordinate_system")
            # Check for window_name match if config stores it (optional enhancement)
            # saved_window_name = config_data.get("window")
            saved_window_geometry = config_data.get("window_geometry")

            # Backward compatibility and system determination logic
            if saved_coord_system:
                coordinate_system = saved_coord_system
            elif saved_window_geometry:  # If geo exists but system doesn't, assume old relative format
                coordinate_system = COORD_SYSTEM_RELATIVE
                print(f"Loading using inferred '{COORD_SYSTEM_RELATIVE}' system (for backward compatibility).")
            else:  # Otherwise assume old absolute format
                coordinate_system = COORD_SYSTEM_ABSOLUTE
                print(f"Loading using inferred '{COORD_SYSTEM_ABSOLUTE}' system (for backward compatibility).")
            # --- ---

            print(f"Using coordinate system: {coordinate_system} from config {config_path}")

            rectangles_data = config_data.get("rectangles", [])
            self.rectangles = []  # Clear existing internal rectangles
            loaded_count = 0
            skipped_count = 0

            for rect_data in rectangles_data:
                monitor_data = rect_data.get("monitor")  # Monitor info might be needed if not just index
                coords = rect_data.get("coordinates")  # Could be %, relative px, or absolute px
                is_excluded = rect_data.get("is_excluded", False)

                # Basic validation of loaded data structure
                if not (monitor_data and isinstance(monitor_data, dict) and 'index' in monitor_data and
                        isinstance(coords, list) and len(coords) == 4):
                    print(f"Skipping invalid rectangle data structure: {rect_data}")
                    skipped_count += 1
                    continue

                abs_coords = None  # Will hold the final absolute pixel coordinates (x, y, w, h)

                # --- Convert loaded coords to absolute pixels ---
                try:
                    if coordinate_system == COORD_SYSTEM_PERCENTAGE:
                        if current_window_geometry:
                            win_w = current_window_geometry['width']
                            win_h = current_window_geometry['height']
                            win_l = current_window_geometry['left']
                            win_t = current_window_geometry['top']
                            # Ensure dimensions are valid for calculation
                            if win_w <= 0 or win_h <= 0:
                                raise ValueError("Current window dimensions are invalid for percentage calculation.")

                            x_pct, y_pct, w_pct, h_pct = map(float, coords)  # Ensure float

                            # Calculate absolute pixel values
                            x_abs = (x_pct * win_w) + win_l
                            y_abs = (y_pct * win_h) + win_t
                            w_abs = w_pct * win_w
                            h_abs = h_pct * win_h
                            abs_coords = (int(x_abs), int(y_abs), int(w_abs), int(h_abs))
                        else:
                            raise ValueError(f"Cannot convert percentage coords {coords}, target window not found now.")

                    elif coordinate_system == COORD_SYSTEM_RELATIVE:
                        if current_window_geometry:
                            x_rel, y_rel, w_pix, h_pix = map(float, coords)  # Read as float first
                            x_abs = x_rel + current_window_geometry['left']
                            y_abs = y_rel + current_window_geometry['top']
                            abs_coords = (int(x_abs), int(y_abs), int(w_pix), int(h_pix))
                        else:
                            raise ValueError(
                                f"Cannot convert relative pixel coords {coords}, target window not found now.")

                    elif coordinate_system == COORD_SYSTEM_ABSOLUTE:
                        # Assume absolute pixels
                        abs_coords = tuple(int(float(c)) for c in coords)  # Allow float->int conversion
                    else:
                        # Fallback for unknown system: treat as absolute
                        print(
                            f"Warning: Unknown coordinate system '{coordinate_system}'. Treating coords {coords} as absolute.")
                        abs_coords = tuple(int(float(c)) for c in coords)

                except (ValueError, TypeError, KeyError, IndexError) as e:
                    print(f"Error processing coords {coords} with system '{coordinate_system}': {e}. Skipping rect.")
                    skipped_count += 1
                    continue  # Skip this rectangle if conversion failed
                # --- End Conversion ---

                # Validate size using the final absolute pixel coordinates
                if coordinate_system == COORD_SYSTEM_PERCENTAGE or (abs_coords and abs_coords[2] >= MIN_RECT_WIDTH and abs_coords[3] >= MIN_RECT_HEIGHT):
                    # Find the correct monitor dict from self.monitors based on index
                    monitor_index = monitor_data['index']
                    target_monitor = next((m for m in self.monitors if m['index'] == monitor_index), None)
                    if target_monitor:
                        # Store the monitor dict from *this* instance and absolute pixel coordinates internally
                        self.rectangles.append((target_monitor, abs_coords, is_excluded))
                        loaded_count += 1
                    else:
                        print(
                            f"Warning: Monitor with index {monitor_index} not found in current setup. Skipping rect {abs_coords}.")
                        skipped_count += 1
                elif abs_coords:
                    print(
                        f"Skipping small rectangle (pixels): W={abs_coords[2]}, H={abs_coords[3]} (from original {coords})")
                    skipped_count += 1
                # else: conversion failed, already printed message

            print(f"Loaded {loaded_count} rectangles, skipped {skipped_count} from {config_path}")

        except FileNotFoundError:
            print(f"No existing config found at {config_path}. Starting fresh.")
        except json.JSONDecodeError:
            print(f"Error decoding JSON from {config_path}. Check file format. Starting fresh.")
        except Exception as e:
            print(f"An unexpected error occurred while loading rectangles: {e}")
            import traceback
            traceback.print_exc()  # More detail on unexpected errors

    def save_rects(self, event=None):
        """Saves rectangles to the config file, using percentages if window is targeted."""
        # Use the window geometry found during __init__ for consistency during save
        window_geom_to_save = self.target_window_geometry
        save_coord_system = COORD_SYSTEM_ABSOLUTE  # Default if no window

        config_path = self.get_scene_ocr_config()
        print(f"Saving rectangles to: {config_path}")

        try:
            # --- Determine coordinate system for saving ---
            if window_geom_to_save:
                # We have a window, try to save as percentages
                win_l = window_geom_to_save['left']
                win_t = window_geom_to_save['top']
                win_w = window_geom_to_save['width']
                win_h = window_geom_to_save['height']
                # Basic check for valid dimensions needed for percentage calculation
                if win_w > 0 and win_h > 0:
                    save_coord_system = COORD_SYSTEM_PERCENTAGE
                    win_l = window_geom_to_save['left']
                    win_t = window_geom_to_save['top']
                    print(f"Saving using coordinate system: {save_coord_system} relative to {window_geom_to_save}")
                else:
                    print(
                        f"Warning: Window dimensions are invalid ({win_w}x{win_h}). Saving as absolute pixels instead.")
                    save_coord_system = COORD_SYSTEM_ABSOLUTE
                    window_geom_to_save = None  # Don't save invalid geometry
            else:
                # No window found, save as absolute pixels
                save_coord_system = COORD_SYSTEM_ABSOLUTE
                print(f"Saving using coordinate system: {save_coord_system}")
            # --- ---

            serializable_rects = []
            for monitor_dict, abs_coords, is_excluded in self.rectangles:
                # abs_coords are the internal absolute pixels (x_abs, y_abs, w_abs, h_abs)
                x_abs, y_abs, w_abs, h_abs = abs_coords
                coords_to_save = []

                # --- Convert absolute pixels to the chosen system ---
                if save_coord_system == COORD_SYSTEM_PERCENTAGE and window_geom_to_save:
                    # Calculate percentages (handle potential float precision issues if necessary)
                    x_pct = (x_abs - win_l) / win_w
                    y_pct = (y_abs - win_t) / win_h
                    w_pct = w_abs / win_w
                    h_pct = h_abs / win_h
                    # Round percentages slightly to avoid overly long floats? Optional.
                    # precision = 6+
                    # coords_to_save = [round(x_pct, precision), round(y_pct, precision), round(w_pct, precision), round(h_pct, precision)]
                    coords_to_save = [x_pct, y_pct, w_pct, h_pct]
                else:
                    # Save absolute pixel coordinates
                    coords_to_save = list(abs_coords)
                    save_coord_system = COORD_SYSTEM_ABSOLUTE  # Ensure we note this system

                # --- End Conversion ---

                # Create serializable monitor info (e.g., just index)
                monitor_info_to_save = {'index': monitor_dict['index']}  # Save minimal info

                rect_data = {
                    "monitor": monitor_info_to_save,
                    "coordinates": coords_to_save,
                    "is_excluded": is_excluded
                }
                serializable_rects.append(rect_data)

            # Prepare final data structure for JSON
            save_data = {
                "scene": obs.get_current_scene() or "default_scene",
                "window": self.window_name,  # Store targeted window name
                "coordinate_system": save_coord_system,  # Explicitly save the system used
                "rectangles": serializable_rects
            }
            # Only add window_geometry if it was valid and used for non-absolute saving
            if window_geom_to_save and save_coord_system != COORD_SYSTEM_ABSOLUTE:
                save_data["window_geometry"] = window_geom_to_save  # Save geometry used for % calc

            # Write to JSON file
            with open(config_path, 'w', encoding="utf-8") as f:
                json.dump(save_data, f, indent=4, ensure_ascii=False)

            print(f"Successfully saved {len(serializable_rects)} rectangles.")
            # Pass back the internally stored ABSOLUTE coordinates and context
            # Need to convert internal tuples to lists for the manager dict
            abs_rects_list = [(r[0], list(r[1]), r[2]) for r in self.rectangles]
            self.result['rectangles'] = abs_rects_list
            self.result['window_geometry'] = window_geom_to_save  # Pass back geometry used (or None)
            self.result['coordinate_system'] = save_coord_system  # Pass back system used for saving

            self.quit_app()  # Close the selector UI after saving

        except Exception as e:
            print(f"Failed to save rectangles: {e}")
            import traceback
            traceback.print_exc()
            # Optionally: Show an error message to the user in the UI
            # Do not destroy the root window on error, allow user to retry or quit
            # self.root.destroy()

    def undo_last_rect(self, event=None):
        """Removes the last drawn rectangle."""
        if self.rectangles and self.drawn_rect_ids:
            # Pop the internal data
            last_rect_tuple = self.rectangles.pop()  # (monitor_dict, abs_coords, is_excluded)
            # Pop the corresponding canvas ID (fragile if IDs aren't managed carefully)
            # This assumes drawn_rect_ids corresponds directly to rectangles, which might break
            # if deletes happened without updating both lists perfectly.
            # A better approach links the canvas ID directly to the rectangle data.
            # For now, we'll assume simple append/pop correspondence.

            # Find the canvas ID associated with this rectangle
            monitor_index = last_rect_tuple[0]['index']
            canvas = self.canvas_windows.get(monitor_index)

            # Find the *specific* ID on that canvas to delete
            # We need a way to map the internal rect tuple to the canvas ID
            # Let's store ID with the rect temporarily: self.rectangles stores (mon, coords, excluded, canvas_id)
            # Redo stack needs update too. Simpler for now: Assume last ID is correct.

            if self.drawn_rect_ids:  # Check if the list is not empty
                last_rect_id = self.drawn_rect_ids.pop()  # Get the assumed corresponding ID

                # Add to redo stack (including the ID)
                self.redo_stack.append((*last_rect_tuple, last_rect_id))  # (mon, coords, excluded, id)

                if canvas:
                    try:
                        # Check if ID exists on this canvas before deleting
                        if last_rect_id in canvas.find_all():
                            canvas.delete(last_rect_id)
                            print(f"Undo: Deleted rectangle ID {last_rect_id} from canvas {monitor_index}")
                        else:
                            print(f"Warning: Undo - Rect ID {last_rect_id} not found on canvas {monitor_index}.")
                    except tk.TclError as e:
                        print(f"Warning: TclError during undo delete: {e}")
                        pass  # Ignore if already deleted or canvas gone
                else:
                    print(f"Warning: Undo - Canvas for monitor index {monitor_index} not found.")
            else:
                print("Warning: Undo failed - drawn_rect_ids list is empty.")
                # Put the rectangle back if ID list was empty?
                self.rectangles.append(last_rect_tuple)


        elif self.current_rect_id is not None:
            # If undoing during drag (before rectangle is finalized in self.rectangles)
            active_canvas = None
            # Find which canvas holds the temporary rectangle
            for canvas in self.canvas_windows.values():
                if self.current_rect_id in canvas.find_all():
                    active_canvas = canvas
                    break
            if active_canvas:
                try:
                    active_canvas.delete(self.current_rect_id)
                    print("Undo: Deleted temporary rectangle.")
                except tk.TclError:
                    pass  # Ignore if already deleted
            self.current_rect_id = None
            self.start_x = None
            self.start_y = None

    def redo_last_rect(self, event=None):
        """Redraws the last undone rectangle."""
        if not self.redo_stack:
            print("Redo: Nothing to redo.")
            return

        # Pop monitor, absolute coords, is_excluded, and the original canvas ID
        monitor, abs_coords, is_excluded, old_rect_id = self.redo_stack.pop()
        monitor_index = monitor['index']
        canvas = self.canvas_windows.get(monitor_index)

        if canvas:
            x_abs, y_abs, w_abs, h_abs = abs_coords  # Use absolute coords for drawing
            outline_color = 'green' if not is_excluded else 'orange'

            # Convert absolute screen coords to canvas-local coords for drawing
            canvas_x = x_abs - monitor['left']
            canvas_y = y_abs - monitor['top']

            try:
                # Draw using coordinates relative to the canvas/monitor window
                # IMPORTANT: This creates a *new* canvas ID
                new_rect_id = canvas.create_rectangle(
                    canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
                    outline=outline_color, width=2
                )

                # Store the absolute coordinates and the *new* ID internally again
                self.rectangles.append((monitor, abs_coords, is_excluded))
                self.drawn_rect_ids.append(new_rect_id)  # Add the NEW ID
                print(f"Redo: Restored rectangle with new ID {new_rect_id} on canvas {monitor_index}")

            except tk.TclError as e:
                print(f"Warning: TclError during redo draw: {e}")
                # If drawing fails, put the item back on the redo stack?
                self.redo_stack.append((monitor, abs_coords, is_excluded, old_rect_id))
        else:
            print(f"Warning: Redo - Canvas for monitor index {monitor_index} not found.")
            # Put the item back on the redo stack if canvas not found
            self.redo_stack.append((monitor, abs_coords, is_excluded, old_rect_id))

    def create_window(self, monitor):
        """Creates the transparent overlay window for a single monitor."""
        monitor_index = monitor['index']  # Assumes index is set
        monitor_left, monitor_top = monitor['left'], monitor['top']
        monitor_width, monitor_height = monitor['width'], monitor['height']

        try:
            # Grab screenshot for this specific monitor
            screenshot = self.sct.grab(monitor)
            img = Image.frombytes('RGB', (screenshot.width, screenshot.height), screenshot.rgb)

            # Resize if screenshot dimensions don't match monitor info (e.g., DPI scaling)
            if img.width != monitor_width or img.height != monitor_height:
                print(
                    f"Monitor {monitor_index}: Resizing screenshot from {img.size} to monitor size {monitor_width}x{monitor_height}")
                img = img.resize((monitor_width, monitor_height), Image.Resampling.LANCZOS)

        except Exception as e:
            print(f"Error grabbing screenshot for monitor {monitor_index}: {e}")
            # Create a blank placeholder image on error
            img = Image.new('RGB', (monitor_width, monitor_height), color='grey')
            draw = ImageDraw.Draw(img)
            draw.text((10, 10), f"Error grabbing screen {monitor_index}", fill="red")

        # Create the Toplevel window
        window = tk.Toplevel(self.root)
        window.geometry(f"{monitor_width}x{monitor_height}+{monitor_left}+{monitor_top}")
        window.overrideredirect(1)  # Frameless window
        window.attributes('-topmost', 1)  # Keep on top
        window.attributes("-alpha", 1.0 if self.image_mode else 0.2)  # Initial transparency

        img_tk = ImageTk.PhotoImage(img)

        # Create the canvas covering the entire window
        canvas = tk.Canvas(window, cursor='cross', highlightthickness=0,
                           width=monitor_width, height=monitor_height)
        canvas.pack(fill=tk.BOTH, expand=True)
        # Keep a reference to the PhotoImage to prevent garbage collection!
        canvas.image = img_tk
        # Draw the background image onto the canvas
        bg_img_id = canvas.create_image(0, 0, image=img_tk, anchor=tk.NW)
        # Store the canvas widget, mapping from monitor index
        self.canvas_windows[monitor_index] = canvas

        # Store references for potential refreshing or cleanup
        self.monitor_windows[monitor_index] = {
            'window': window,
            'canvas': canvas,
            'bg_img_id': bg_img_id,  # ID of the background image item
        }

        # --- Draw existing rectangles loaded from config ---
        # These are already converted to absolute pixel coordinates in self.rectangles
        drawn_on_this_canvas = []
        for mon_data, abs_coords, is_excluded in self.rectangles:
            if mon_data['index'] == monitor_index:
                x_abs, y_abs, w_abs, h_abs = abs_coords
                # Convert absolute screen coords to canvas-local coords for drawing
                canvas_x = x_abs - monitor_left
                canvas_y = y_abs - monitor_top
                outline_color = 'green' if not is_excluded else 'orange'
                try:
                    rect_id = canvas.create_rectangle(
                        canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
                        outline=outline_color, width=2
                    )
                    # IMPORTANT: Store the generated ID. Needs careful mapping back to self.rectangles later
                    # For simplicity now, just add to the global list.
                    self.drawn_rect_ids.append(rect_id)
                    drawn_on_this_canvas.append(rect_id)
                except tk.TclError as e:
                    print(f"Warning: TclError drawing existing rectangle {abs_coords} on canvas {monitor_index}: {e}")
        print(f"Drew {len(drawn_on_this_canvas)} existing rectangles on monitor {monitor_index}")

        # --- Define Event Handlers specific to this canvas instance ---
        def on_click(event):
            # event.x, event.y are relative to the canvas widget
            if self.current_rect_id is None:
                self.start_x, self.start_y = event.x, event.y  # Store canvas coords
                # Determine color/state (Shift key for exclusion)
                is_exclusion = bool(event.state & 0x0001)
                outline_color = 'purple' if is_exclusion else 'red'  # Temp color while drawing
                try:
                    # Create rectangle on *this* specific canvas
                    self.current_rect_id = canvas.create_rectangle(
                        self.start_x, self.start_y, self.start_x, self.start_y,
                        outline=outline_color, width=2
                    )
                except tk.TclError as e:
                    print(f"Warning: TclError creating rectangle on canvas {monitor_index}: {e}")
                    self.current_rect_id = None  # Reset state if creation failed

        def on_drag(event):
            # Update the temporary rectangle being drawn on *this* canvas
            if self.current_rect_id:
                try:
                    # Use canvas coords directly
                    canvas.coords(self.current_rect_id, self.start_x, self.start_y, event.x, event.y)
                except tk.TclError as e:
                    print(f"Warning: TclError updating coords during drag on canvas {monitor_index}: {e}")
                    # Option: delete the rect and stop drag?
                    # canvas.delete(self.current_rect_id)
                    # self.current_rect_id = None
                    pass

        def on_release(event):
            # Finalize the rectangle drawn on *this* canvas
            if self.current_rect_id:
                current_rect_id_local = self.current_rect_id  # Store locally in case it's reset
                self.current_rect_id = None  # Reset global temp ID tracker

                try:
                    # Get final coords relative to this canvas
                    canvas_x1, canvas_y1, canvas_x2, canvas_y2 = canvas.coords(current_rect_id_local)

                    # Convert canvas-local coords to absolute screen coords for storage
                    # Ensure correct order (x1,y1 is top-left)
                    abs_x1 = int(min(canvas_x1, canvas_x2) + monitor_left)
                    abs_y1 = int(min(canvas_y1, canvas_y2) + monitor_top)
                    abs_x2 = int(max(canvas_x1, canvas_x2) + monitor_left)
                    abs_y2 = int(max(canvas_y1, canvas_y2) + monitor_top)

                    # Calculate absolute width/height
                    width_abs = abs_x2 - abs_x1
                    height_abs = abs_y2 - abs_y1

                    # Check against minimum size
                    if width_abs >= MIN_RECT_WIDTH and height_abs >= MIN_RECT_HEIGHT:
                        is_excluded = bool(event.state & 0x0001)  # Check Shift key state at release
                        final_outline = 'orange' if is_excluded else 'green'  # Final color
                        canvas.itemconfig(current_rect_id_local, outline=final_outline)

                        # Store the absolute coordinates and monitor info internally
                        abs_coords_tuple = (abs_x1, abs_y1, width_abs, height_abs)
                        # Add to internal list (using the correct monitor dictionary)
                        self.rectangles.append((monitor, abs_coords_tuple, is_excluded))
                        # Add the ID of the rectangle just drawn on this canvas
                        self.drawn_rect_ids.append(current_rect_id_local)
                        # Clear redo stack on new action
                        self.redo_stack.clear()
                        print(
                            f"Stored rectangle: Abs={abs_coords_tuple}, Excluded={is_excluded}, ID={current_rect_id_local}")
                    else:
                        # Rectangle too small, delete it from the canvas
                        canvas.delete(current_rect_id_local)
                        print(f"Skipping small rectangle: W={width_abs}, H={height_abs}")

                except tk.TclError as e:
                    print(f"Warning: TclError processing rectangle on release on canvas {monitor_index}: {e}")
                    # Attempt cleanup if ID still exists
                    try:
                        if current_rect_id_local in canvas.find_all():
                            canvas.delete(current_rect_id_local)
                    except tk.TclError:
                        pass  # Ignore cleanup error

                finally:
                    # Always reset start coordinates
                    self.start_x = None
                    self.start_y = None

        def on_right_click(event):
            # Find rectangle item under cursor on *this* canvas
            # Use find_closest initially, then check if it's overlapping and a rectangle we manage
            # find_closest returns a tuple, possibly empty
            items = canvas.find_closest(event.x, event.y)
            target_id_to_delete = None
            if items:
                item_id = items[0]  # Get the closest item ID
                # Check if this ID is one we drew and if the click is actually inside its bbox
                if item_id in self.drawn_rect_ids and canvas.type(item_id) == 'rectangle':
                    bbox = canvas.bbox(item_id)
                    if bbox and bbox[0] <= event.x <= bbox[2] and bbox[1] <= event.y <= bbox[3]:
                        target_id_to_delete = item_id

            if target_id_to_delete is not None:
                try:
                    # --- Find the corresponding rectangle in self.rectangles ---
                    # This requires matching the canvas ID or recalculating absolute coords
                    found_rect_index = -1

                    # Method 1: Match by recalculating absolute coords (more robust)
                    canvas_coords = canvas.coords(target_id_to_delete)  # canvas x1,y1,x2,y2
                    rect_abs_x = int(min(canvas_coords[0], canvas_coords[2]) + monitor_left)
                    rect_abs_y = int(min(canvas_coords[1], canvas_coords[3]) + monitor_top)
                    rect_w = int(abs(canvas_coords[2] - canvas_coords[0]))
                    rect_h = int(abs(canvas_coords[3] - canvas_coords[1]))

                    for i, (mon, abs_coords, excluded) in enumerate(self.rectangles):
                        # Compare recalculated coords with stored absolute coords (allow small tolerance)
                        if mon['index'] == monitor_index and \
                                abs(abs_coords[0] - rect_abs_x) < 2 and \
                                abs(abs_coords[1] - rect_abs_y) < 2 and \
                                abs(abs_coords[2] - rect_w) < 2 and \
                                abs(abs_coords[3] - rect_h) < 2:
                            found_rect_index = i
                            break

                    # --- Delete if found ---
                    if found_rect_index != -1:
                        print(
                            f"Deleting rectangle index {found_rect_index} (ID {target_id_to_delete}) on canvas {monitor_index}")
                        # Remove from internal list
                        del self.rectangles[found_rect_index]
                        # Remove from the ID list
                        self.drawn_rect_ids.remove(target_id_to_delete)
                        # Clear redo stack on new action
                        self.redo_stack.clear()
                        # Delete from canvas
                        canvas.delete(target_id_to_delete)
                    else:
                        print(
                            f"Warning: Could not find internal rectangle data matching canvas ID {target_id_to_delete} for deletion.")
                        # Optionally still delete from canvas if found, but lists will be inconsistent
                        # canvas.delete(target_id_to_delete)
                        # if target_id_to_delete in self.drawn_rect_ids: self.drawn_rect_ids.remove(target_id_to_delete)

                except tk.TclError as e:
                    print(f"Warning: TclError deleting rectangle ID {target_id_to_delete} on right click: {e}")
                except ValueError:
                    # This happens if ID was already removed from drawn_rect_ids somehow
                    print(
                        f"Warning: Rectangle ID {target_id_to_delete} not found in drawn_rect_ids list during delete.")
                    # Still try to delete from canvas if possible
                    try:
                        canvas.delete(target_id_to_delete)
                    except:
                        pass

        def toggle_image_mode(event=None):
            """Toggles the transparency of the overlay window."""
            self.image_mode = not self.image_mode
            alpha = 1.0 if self.image_mode else 0.25  # Adjust alpha value as needed
            # Apply alpha to all monitor windows
            for mon_idx in self.monitor_windows:
                try:
                    self.monitor_windows[mon_idx]['window'].attributes("-alpha", alpha)
                except Exception as e:
                    print(f"Error setting alpha for monitor {mon_idx}: {e}")

        # --- Bind Events to the canvas ---
        canvas.bind('<ButtonPress-1>', on_click)  # Left click start
        canvas.bind('<B1-Motion>', on_drag)  # Left drag
        canvas.bind('<ButtonRelease-1>', on_release)  # Left click release
        canvas.bind('<Button-3>', on_right_click)  # Right click delete
        canvas.bind('<Control-s>', self.save_rects)  # Save
        canvas.bind('<Control-z>', self.undo_last_rect)  # Undo
        canvas.bind('<Control-y>', self.redo_last_rect)  # Redo
        canvas.bind("<m>", toggle_image_mode)  # Toggle image mode (alpha)


        # --- Bind Global Actions to the window (apply to all windows) ---
        # Use lambdas to ensure the correct toggle function is called if needed,
        # but here toggle_image_mode already affects all windows.
        window.bind('<Control-s>', self.save_rects)  # Save
        window.bind('<Control-z>', self.undo_last_rect)  # Undo
        window.bind('<Control-y>', self.redo_last_rect)  # Redo
        # # Optional: Add non-Ctrl versions if desired
        window.bind('<s>', self.save_rects)
        window.bind('<z>', self.undo_last_rect)
        window.bind('<y>', self.redo_last_rect)
        window.bind("<Escape>", self.quit_app)  # Quit
        window.bind('<Button-3>', on_right_click)  # Right click delete
        window.bind("<m>", toggle_image_mode)  # Toggle image mode (alpha)

    def start(self):
        """Initializes the Tkinter root and creates windows for each monitor."""
        self.root = tk.Tk()
        self.root.withdraw()  # Hide the main useless root window

        if not self.monitors:
            print("Error: No monitors available to display.")
            self.result['error'] = "No monitors found"  # Report back error
            self.root.destroy()
            return

        print(f"Creating selection windows for {len(self.monitors)} monitor(s)...")
        for monitor in self.monitors:
            self.create_window(monitor)  # Create overlay for each monitor

        # Check if any canvas windows were actually created
        if not self.canvas_windows:
            print("Error: Failed to create any monitor selection windows.")
            self.result['error'] = "Failed to create monitor windows"
            self.root.destroy()
            return

        print("Starting Tkinter main loop. Press Esc to quit, Ctrl+S to save.")
        self.root.mainloop()  # Start the event loop

    def quit_app(self, event=None):
        """Initiates the cleanup and shutdown process."""
        print("Quit signal received, closing application...")
        self.on_close()  # Trigger cleanup

    def on_close(self):
        """Cleans up Tkinter resources."""
        # Check if root exists and hasn't been destroyed already
        if self.root and self.root.winfo_exists():
            print("Destroying Tkinter windows...")
            try:
                # Explicitly destroy child windows first (Toplevels)
                for monitor_index in list(self.monitor_windows.keys()):  # Iterate over keys copy
                    win_info = self.monitor_windows.pop(monitor_index, None)
                    if win_info and win_info.get('window'):
                        try:
                            if win_info['window'].winfo_exists():
                                win_info['window'].destroy()
                        except tk.TclError:
                            pass  # Ignore if already destroyed
                # Now destroy the root window
                self.root.quit()  # Exit mainloop first
                self.root.destroy()
                print("Tkinter windows destroyed.")
            except Exception as e:
                print(f"Error during Tkinter cleanup: {e}")
            finally:
                self.root = None  # Ensure root is marked as gone
                self.canvas_windows.clear()
                self.monitor_windows.clear()
        else:
            print("Cleanup: Root window already destroyed or not initialized.")


# --- Multiprocessing Functions ---

def run_screen_selector(result_dict, window_name):
    """Target function for the separate process. Handles setup and running."""
    try:
        selector = ScreenSelector(result_dict, window_name)
        selector.start()
        # Result dictionary is updated directly by selector.save_rects or on error
        print("ScreenSelector process finished.")
    except ImportError as e:
        print(f"Import error in subprocess: {e}")
        result_dict['error'] = str(e)  # Report error back via manager dict
    except Exception as e:
        print(f"Error running ScreenSelector in subprocess: {e}")
        import traceback
        traceback.print_exc()  # Print detailed traceback in the subprocess console
        result_dict['error'] = f"Runtime error: {e}"  # Report error back


def get_screen_selection(window_name):
    """
    Launches the ScreenSelector in a separate process and returns the result.
    Returns None on failure or cancellation, otherwise a dict containing:
    {'rectangles': list_of_abs_coords, 'window_geometry': dict_or_None, 'coordinate_system': str}
    """
    if not selector_available:
        print('Fatal Error: tkinter is not installed or available.')
        return None
    if not gw:
        print('Fatal Error: pygetwindow is not installed or available.')
        return None

    with Manager() as manager:
        # Use a Manager dictionary for safe inter-process communication
        result_data = manager.dict()
        process = Process(target=run_screen_selector, args=(result_data, window_name))

        print(f"Starting ScreenSelector process for window: '{window_name or 'None'}'...")
        process.start()
        process.join()  # Wait for the ScreenSelector process to complete
        print("ScreenSelector process joined.")

        # Process results from the Manager dictionary
        if 'error' in result_data:
            print(f"ScreenSelector process reported an error: {result_data['error']}")
            return None  # Indicate failure
        elif 'rectangles' in result_data:
            print("Screen selection successful.")
            # Return a standard dictionary copy from the Manager dict
            return {
                "rectangles": result_data.get('rectangles'),  # List of (monitor, [abs_coords], excluded)
                "window_geometry": result_data.get('window_geometry'),  # Dict or None
                "coordinate_system": result_data.get('coordinate_system')  # String constant
            }
        else:
            # This case usually means the user quit (Esc) without saving
            print("No selection saved or process was cancelled by user.")
            return {}  # Return empty dict to indicate cancellation without error


# --- Main Execution Block ---
if __name__ == "__main__":
    target_window_title = None  # Default to absolute coordinates
    # Check for command line arguments to specify window title
    set_dpi_awareness()
    if len(sys.argv) > 1:
        target_window_title = sys.argv[1]
        print(f"Attempting to target window title from args: '{target_window_title}'")
    else:
        print("Usage: python your_script_name.py [\"Target Window Title\"]")
        print("No window title provided. Using absolute screen coordinates.")
        # Example: uncomment below to target Calculator on Windows by default if no arg given
        # if sys.platform == "win32": target_window_title = "Calculator"

    # if not target_window_title:
    #     target_window_title = get_ocr_config().window

    if not target_window_title:
        target_window_title = "Windowed Projector (Preview)"

    # Get the selection result
    selection_result = get_screen_selection(target_window_title)

    # --- Process and display the result ---
    if selection_result is None:
        print("\n--- Screen selection failed due to an error. ---")
    elif not selection_result:  # Empty dict means cancelled
        print("\n--- Screen selection was cancelled by the user. ---")
    elif 'rectangles' in selection_result:
        print("\n--- Selection Result ---")
        rectangles = selection_result.get('rectangles', [])
        window_geom = selection_result.get('window_geometry')
        coord_sys = selection_result.get('coordinate_system')

        print(f"Coordinate system used for saving: {coord_sys}")
        if window_geom:
            print(f"Saved relative to window geometry: {window_geom}")
        # else: It was COORD_SYSTEM_ABSOLUTE, no geometry saved/used

        print(f"Selected rectangles returned ({len(rectangles)}):")
        # The returned coordinates are always absolute pixels for external use
        for i, (monitor, coords, is_excluded) in enumerate(rectangles):
            # Safely access monitor info
            monitor_info = f"Idx:{monitor.get('index', 'N/A')} Pos:({monitor.get('left', '?')},{monitor.get('top', '?')}) W:{monitor.get('width', '?')} H:{monitor.get('height', '?')}"
            # Format absolute pixel coordinates
            coord_str = f"({coords[0]}, {coords[1]}, W:{coords[2]}, H:{coords[3]})"
            print(f"  Rect {i + 1}: Monitor={monitor_info}, Coords={coord_str}, Excluded={is_excluded}")
    else:
        # Should not happen if get_screen_selection returns correctly, but handles unexpected cases
        print("\n--- Screen selection returned an unexpected result. ---")
        print(selection_result)
