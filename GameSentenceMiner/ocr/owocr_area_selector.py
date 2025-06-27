import ctypes
import json
import sys
from multiprocessing import Process, Manager
from pathlib import Path

import mss
from PIL import Image, ImageTk

# Assuming a mock or real obs module exists in this path
from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness, get_window
from GameSentenceMiner.util.gsm_utils import sanitize_filename

try:
    import pygetwindow as gw
except ImportError:
    print("Error: pygetwindow library not found. Please install it: pip install pygetwindow")
    gw = None

try:
    import tkinter as tk
    from tkinter import font as tkfont  # NEW: Import for better font control

    selector_available = True
except ImportError:
    print("Error: tkinter library not found. GUI selection is unavailable.")
    selector_available = False

MIN_RECT_WIDTH = 25
MIN_RECT_HEIGHT = 25

COORD_SYSTEM_PERCENTAGE = "percentage"


class ScreenSelector:
    def __init__(self, result, window_name, use_window_as_config):
        if not selector_available or not gw:
            raise RuntimeError("tkinter or pygetwindow is not available.")
        if not window_name:
            raise ValueError("A target window name is required for percentage-based coordinates.")

        obs.connect_to_obs_sync()
        self.window_name = window_name
        print(f"Targeting window: '{window_name}'")

        self.sct = mss.mss()
        self.monitors = self.sct.monitors[1:]
        if not self.monitors:
            raise RuntimeError("No monitors found by mss.")
        for i, monitor in enumerate(self.monitors):
            monitor['index'] = i

        # --- Window Awareness is now critical ---
        self.target_window = self._find_target_window()
        self.target_window_geometry = self._get_window_geometry(self.target_window)
        if not self.target_window_geometry:
            raise RuntimeError(f"Could not find or get geometry for window '{self.window_name}'.")
        print(f"Found target window at: {self.target_window_geometry}")
        # ---

        self.root = None
        self.scene = ''
        self.use_window_as_config = use_window_as_config
        self.result = result
        self.rectangles = []  # Internal storage is ALWAYS absolute pixels for drawing
        self.drawn_rect_ids = []
        self.current_rect_id = None
        self.start_x = self.start_y = None
        self.image_mode = True
        self.redo_stack = []
        self.bounding_box = {}  # Geometry of the single large canvas window

        self.load_existing_rectangles()

    def _find_target_window(self):
        try:
            return get_window(self.window_name)
        except Exception as e:
            print(f"Error finding window '{self.window_name}': {e}")
            return None

    def _get_window_geometry(self, window):
        if window:
            try:
                # Ensure width/height are positive and non-zero
                width = max(1, window.width)
                height = max(1, window.height)
                return {"left": window.left, "top": window.top, "width": width, "height": height}
            except Exception:
                return None
        return None

    def get_scene_ocr_config(self):
        app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
        ocr_config_dir = app_dir / "ocr_config"
        ocr_config_dir.mkdir(parents=True, exist_ok=True)
        try:
            if self.use_window_as_config:
                self.scene = sanitize_filename(self.window_name)
            else:
                self.scene = sanitize_filename(obs.get_current_scene() or "")
        except Exception as e:
            print(f"Error getting OBS scene: {e}. Using default config name.")
            self.scene = ""
        return ocr_config_dir / f"{self.scene}.json"

    def load_existing_rectangles(self):
        """Loads rectangles from config, converting from percentage to absolute pixels for use."""
        config_path = self.get_scene_ocr_config()
        win_geom = self.target_window_geometry  # Use current geometry for conversion
        win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']

        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)

            if config_data.get("coordinate_system") != COORD_SYSTEM_PERCENTAGE:
                print(
                    f"Warning: Config file '{config_path}' does not use '{COORD_SYSTEM_PERCENTAGE}' system. Please re-create selections.")
                return

            print(f"Loading rectangles from {config_path}...")
            self.rectangles = []
            loaded_count = 0

            for rect_data in config_data.get("rectangles", []):
                try:
                    coords_pct = rect_data["coordinates"]
                    x_pct, y_pct, w_pct, h_pct = map(float, coords_pct)

                    # Convert from percentage to absolute pixel coordinates
                    x_abs = (x_pct * win_w) + win_l
                    y_abs = (y_pct * win_h) + win_t
                    w_abs = w_pct * win_w
                    h_abs = h_pct * win_h
                    abs_coords = (int(x_abs), int(y_abs), int(w_abs), int(h_abs))

                    monitor_index = rect_data["monitor"]['index']
                    target_monitor = next((m for m in self.monitors if m['index'] == monitor_index), None)
                    if target_monitor:
                        self.rectangles.append((target_monitor, abs_coords, rect_data["is_excluded"]))
                        loaded_count += 1
                except (KeyError, ValueError, TypeError) as e:
                    print(f"Skipping malformed rectangle data: {rect_data}, Error: {e}")

            print(f"Loaded {loaded_count} valid rectangles.")
        except FileNotFoundError:
            print(f"No config found at {config_path}. Starting fresh.")
        except Exception as e:
            print(f"Error loading config: {e}. Starting fresh.")

    def save_rects(self, event=None):
        """Saves rectangles to config, converting from absolute pixels to percentages."""
        config_path = self.get_scene_ocr_config()
        win_geom = self.target_window_geometry
        win_l, win_t, win_w, win_h = win_geom['left'], win_geom['top'], win_geom['width'], win_geom['height']
        print(f"Saving rectangles to: {config_path} relative to window: {win_geom}")

        serializable_rects = []
        for monitor_dict, abs_coords, is_excluded in self.rectangles:
            x_abs, y_abs, w_abs, h_abs = abs_coords

            # Convert absolute pixel coordinates to percentages
            x_pct = (x_abs - win_l) / win_w
            y_pct = (y_abs - win_t) / win_h
            w_pct = w_abs / win_w
            h_pct = h_abs / win_h
            coords_to_save = [x_pct, y_pct, w_pct, h_pct]

            serializable_rects.append({
                "monitor": {'index': monitor_dict['index']},
                "coordinates": coords_to_save,
                "is_excluded": is_excluded
            })

        save_data = {
            "scene": self.scene or "",
            "window": self.window_name,
            "coordinate_system": COORD_SYSTEM_PERCENTAGE,  # Always save as percentage
            "window_geometry": win_geom,  # Save the geometry used for conversion
            "rectangles": serializable_rects
        }

        with open(config_path, 'w', encoding="utf-8") as f:
            json.dump(save_data, f, indent=4, ensure_ascii=False)

        print(f"Successfully saved {len(serializable_rects)} rectangles.")
        # Pass back the internal absolute coords for any immediate post-processing
        self.result['rectangles'] = [(r[0], list(r[1]), r[2]) for r in self.rectangles]
        self.result['window_geometry'] = win_geom
        self.result['coordinate_system'] = COORD_SYSTEM_PERCENTAGE
        self.quit_app()

    def undo_last_rect(self, event=None):
        if self.rectangles and self.drawn_rect_ids:
            last_rect_tuple = self.rectangles.pop()
            last_rect_id = self.drawn_rect_ids.pop()
            self.redo_stack.append((*last_rect_tuple, last_rect_id))
            event.widget.winfo_toplevel().winfo_children()[0].delete(last_rect_id)
            print("Undo: Removed last rectangle.")

    def redo_last_rect(self, event=None):
        if not self.redo_stack: return
        monitor, abs_coords, is_excluded, old_rect_id = self.redo_stack.pop()
        canvas = event.widget.winfo_toplevel().winfo_children()[0]
        x_abs, y_abs, w_abs, h_abs = abs_coords
        canvas_x, canvas_y = x_abs - self.bounding_box['left'], y_abs - self.bounding_box['top']
        new_rect_id = canvas.create_rectangle(canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
                                              outline='orange' if is_excluded else 'green', width=2)
        self.rectangles.append((monitor, abs_coords, is_excluded))
        self.drawn_rect_ids.append(new_rect_id)
        print("Redo: Restored rectangle.")

    # --- NEW METHOD TO DISPLAY INSTRUCTIONS ---
    def _create_instructions_widget(self, canvas):
        """Creates a text box with usage instructions on the canvas."""
        instructions_text = (
            "How to Use:\n"
            "  • Left Click + Drag: Create a capture area (green).\n"
            "  • Shift + Left Click + Drag: Create an exclusion area (orange).\n"
            "  • Right-Click on a box: Delete it.\n\n"
            "Hotkeys:\n"
            "  • Ctrl + S: Save and Quit\n"
            "  • Ctrl + Z / Ctrl + Y: Undo / Redo\n"
            "  • M: Toggle background visibility\n"
            "  • I: Toggle these instructions\n"
            "  • Esc: Quit without saving"
            "  "
        )

        # Use a common, readable font
        instruction_font = tkfont.Font(family="Segoe UI", size=10, weight="normal")

        # Create the text item first to get its size
        text_id = canvas.create_text(
            20, 20,  # Position with a small margin
            text=instructions_text,
            anchor=tk.NW,
            fill='white',
            font=instruction_font,
            justify=tk.LEFT
        )

        # Get the bounding box of the text to draw a background
        text_bbox = canvas.bbox(text_id)

        # Create a background rectangle with padding
        rect_id = canvas.create_rectangle(
            text_bbox[0] - 10,  # left
            text_bbox[1] - 10,  # top
            text_bbox[2] + 10,  # right
            text_bbox[3] + 10,  # bottom
            fill='#2B2B2B',  # Dark, semi-opaque background
            outline='white',
            width=1
        )

        # Lower the rectangle so it's behind the text
        canvas.tag_lower(rect_id, text_id)

    def toggle_instructions(self, event=None):
        canvas = event.widget.winfo_toplevel().winfo_children()[0]
        # Find all text and rectangle items (assuming only one of each for instructions)
        text_items = [item for item in canvas.find_all() if canvas.type(item) == 'text']
        rect_items = [item for item in canvas.find_all() if canvas.type(item) == 'rectangle']

        if text_items and rect_items:
            current_state = canvas.itemcget(text_items[0], 'state')
            new_state = tk.NORMAL if current_state == tk.HIDDEN else tk.HIDDEN
            for item in text_items + rect_items:
                canvas.itemconfigure(item, state=new_state)
            print("Toggled instructions visibility.")

    def start(self):
        self.root = tk.Tk()
        self.root.withdraw()

        # Calculate bounding box of all monitors
        left = min(m['left'] for m in self.monitors)
        top = min(m['top'] for m in self.monitors)
        right = max(m['left'] + m['width'] for m in self.monitors)
        bottom = max(m['top'] + m['height'] for m in self.monitors)
        self.bounding_box = {'left': left, 'top': top, 'width': right - left, 'height': bottom - top}

        sct_img = self.sct.grab(self.sct.monitors[0])
        img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")

        window = tk.Toplevel(self.root)
        window.geometry(f"{self.bounding_box['width']}x{self.bounding_box['height']}+{left}+{top}")
        window.overrideredirect(1)
        window.attributes('-topmost', 1)

        self.photo_image = ImageTk.PhotoImage(img)
        canvas = tk.Canvas(window, cursor='cross', highlightthickness=0)
        canvas.pack(fill=tk.BOTH, expand=True)
        canvas.create_image(0, 0, image=self.photo_image, anchor=tk.NW)

        # --- MODIFIED: CALL THE INSTRUCTION WIDGET CREATOR ---
        self._create_instructions_widget(canvas)
        # --- END MODIFICATION ---

        # Draw existing rectangles (which were converted to absolute pixels on load)
        for _, abs_coords, is_excluded in self.rectangles:
            x_abs, y_abs, w_abs, h_abs = abs_coords
            canvas_x = x_abs - self.bounding_box['left']
            canvas_y = y_abs - self.bounding_box['top']
            rect_id = canvas.create_rectangle(canvas_x, canvas_y, canvas_x + w_abs, canvas_y + h_abs,
                                              outline='orange' if is_excluded else 'green', width=2)
            self.drawn_rect_ids.append(rect_id)

        def on_click(event):
            self.start_x, self.start_y = event.x, event.y
            outline = 'purple' if bool(event.state & 0x0001) else 'red'
            self.current_rect_id = canvas.create_rectangle(self.start_x, self.start_y, self.start_x, self.start_y,
                                                           outline=outline, width=2)

        def on_drag(event):
            if self.current_rect_id: canvas.coords(self.current_rect_id, self.start_x, self.start_y, event.x, event.y)

        def on_release(event):
            if not self.current_rect_id: return
            coords = canvas.coords(self.current_rect_id)
            x_abs = int(min(coords[0], coords[2]) + self.bounding_box['left'])
            y_abs = int(min(coords[1], coords[3]) + self.bounding_box['top'])
            w, h = int(abs(coords[2] - coords[0])), int(abs(coords[3] - coords[1]))

            if w >= MIN_RECT_WIDTH and h >= MIN_RECT_HEIGHT:
                is_excl = bool(event.state & 0x0001)
                canvas.itemconfig(self.current_rect_id, outline='orange' if is_excl else 'green')

                center_x, center_y = x_abs + w / 2, y_abs + h / 2
                target_mon = self.monitors[0]
                for mon in self.monitors:
                    if mon['left'] <= center_x < mon['left'] + mon['width'] and mon['top'] <= center_y < mon['top'] + \
                            mon['height']:
                        target_mon = mon
                        break

                self.rectangles.append((target_mon, (x_abs, y_abs, w, h), is_excl))
                self.drawn_rect_ids.append(self.current_rect_id)
                self.redo_stack.clear()
            else:
                canvas.delete(self.current_rect_id)
            self.current_rect_id = self.start_x = self.start_y = None

        def on_right_click(event):
            # Iterate through our rectangles in reverse to find the topmost one.
            for i in range(len(self.rectangles) - 1, -1, -1):
                _monitor, abs_coords, _is_excluded = self.rectangles[i]
                x_abs, y_abs, w_abs, h_abs = abs_coords
                canvas_x1 = x_abs - self.bounding_box['left']
                canvas_y1 = y_abs - self.bounding_box['top']
                canvas_x2 = canvas_x1 + w_abs
                canvas_y2 = canvas_y1 + h_abs

                if canvas_x1 <= event.x <= canvas_x2 and canvas_y1 <= event.y <= canvas_y2:
                    # --- UNDO/REDO CHANGE ---
                    # We found the rectangle. Prepare the 'remove' action.
                    # We need to save the data AND its original index to restore it correctly.
                    rect_tuple_to_del = self.rectangles[i]
                    item_id_to_del = self.drawn_rect_ids[i]

                    self.redo_stack.append((*rect_tuple_to_del, i))

                    # Now, perform the deletion
                    del self.rectangles[i]
                    del self.drawn_rect_ids[i]
                    canvas.delete(item_id_to_del)
                    print("Deleted rectangle.")

                    break  # Stop after deleting the topmost one

        def toggle_image_mode(e=None):
            self.image_mode = not self.image_mode
            # Only change alpha of the main window, not the text widget
            window.attributes("-alpha", 1.0 if self.image_mode else 0.25)
            print("Toggled background visibility.")

        def on_enter(e=None):
            canvas.focus_set()

        canvas.bind('<Enter>', on_enter)
        canvas.bind('<ButtonPress-1>', on_click)
        canvas.bind('<B1-Motion>', on_drag)
        canvas.bind('<ButtonRelease-1>', on_release)
        canvas.bind('<Button-3>', on_right_click)
        canvas.bind('<Control-s>', self.save_rects)
        canvas.bind('<Control-y>', self.redo_last_rect)
        canvas.bind('<Control-z>', self.undo_last_rect)
        canvas.bind("<Escape>", self.quit_app)
        canvas.bind("<m>", toggle_image_mode)
        canvas.bind("<i>", self.toggle_instructions)

        canvas.focus_set()
        # The print message is now redundant but kept for console feedback
        print("Starting UI. See on-screen instructions. Press Esc to quit, Ctrl+S to save.")
        self.root.mainloop()

    def quit_app(self, event=None):
        if self.root and self.root.winfo_exists(): self.root.destroy()
        self.root = None


def run_screen_selector(result_dict, window_name, use_window_as_config):
    try:
        selector = ScreenSelector(result_dict, window_name, use_window_as_config)
        selector.start()
    except Exception as e:
        print(f"Error in selector process: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        result_dict['error'] = str(e)


def get_screen_selection(window_name, use_window_as_config=False):
    if not selector_available or not gw: return None
    if not window_name:
        print("Error: A target window name must be provided.", file=sys.stderr)
        return None

    with Manager() as manager:
        result_data = manager.dict()
        process = Process(target=run_screen_selector, args=(result_data, window_name, use_window_as_config))
        print(f"Starting ScreenSelector process...")
        process.start()
        process.join()

        if 'error' in result_data:
            print(f"Selector process failed: {result_data['error']}", file=sys.stderr)
            return None
        elif 'rectangles' in result_data:
            print("Screen selection successful.")
            return dict(result_data)
        else:
            print("Selection was cancelled by the user.")
            return {}


if __name__ == "__main__":
    set_dpi_awareness()
    target_window_title = "YouTube - JP"
    use_window_as_config = False
    if len(sys.argv) > 1:
        target_window_title = sys.argv[1]
    if len(sys.argv) > 2:
        use_window_as_config = True
        target_window_title = sys.argv[1]

    selection_result = get_screen_selection(target_window_title, use_window_as_config)

    if selection_result is None:
        print("\n--- Screen selection failed. ---")
    elif not selection_result:
        print("\n--- Screen selection cancelled. ---")
    elif 'rectangles' in selection_result:
        print("\n--- Selection Result ---")
        rects = selection_result.get('rectangles', [])
        win_geom = selection_result.get('window_geometry')
        print(f"Saved relative to window: {win_geom}")
        print(f"Selected rectangles ({len(rects)}):")
        # The returned coordinates are absolute pixels for immediate use
        for i, (monitor, coords, is_excluded) in enumerate(rects):
            coord_str = f"(X:{coords[0]}, Y:{coords[1]}, W:{coords[2]}, H:{coords[3]})"
            print(
                f"  Rect {i + 1}: On Monitor Idx:{monitor.get('index', 'N/A')}, Coords={coord_str}, Excluded={is_excluded}")