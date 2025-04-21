import sys
from multiprocessing import Process, Manager
import mss
from GameSentenceMiner import obs

from GameSentenceMiner.util import sanitize_filename
from PIL import Image, ImageTk
import tkinter as tk
import json
from pathlib import Path
import re

try:
    import tkinter as tk
    selector_available = True
except:
    selector_available = False

MIN_RECT_WIDTH = 25  # Minimum width in pixels
MIN_RECT_HEIGHT = 25 # Minimum height in pixels

class ScreenSelector:
    def __init__(self, result, window_name):
        obs.connect_to_obs()
        self.window_name = window_name
        print(window_name)
        self.sct = mss.mss()
        self.monitors = self.sct.monitors[1:]
        self.root = None
        self.result = result
        self.rectangles = []  # List to store (monitor, coordinates, is_excluded) tuples
        self.drawn_rect_ids = []  # List to store canvas rectangle IDs
        self.current_rect_id = None
        self.start_x = None
        self.start_y = None
        self.canvas_windows = {}  # Dictionary to store canvas per monitor
        self.load_existing_rectangles()
        self.image_mode = True
        self.monitor_windows = {}
        self.redo_stack = []

    def get_scene_ocr_config(self):
        """Return the path to the OCR config file in GameSentenceMiner/ocr_config."""
        app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
        ocr_config_dir = app_dir / "ocr_config"
        ocr_config_dir.mkdir(parents=True, exist_ok=True)
        scene = sanitize_filename(obs.get_current_scene())
        config_path = ocr_config_dir / f"{scene}.json"
        return config_path

    def load_existing_rectangles(self):
        config_path = self.get_scene_ocr_config()
        try:
            with open(config_path, 'r') as f:
                config_data = json.load(f)
                if "rectangles" in config_data:
                    self.rectangles = []
                    for rect_data in config_data["rectangles"]:
                        monitor_data = rect_data.get("monitor")
                        coords = rect_data.get("coordinates")
                        is_excluded = rect_data.get("is_excluded", False)
                        if monitor_data and isinstance(coords, list) and len(coords) == 4:
                            x, y, w, h = coords
                            if w >= MIN_RECT_WIDTH and h >= MIN_RECT_HEIGHT:
                                self.rectangles.append((monitor_data, tuple(coords), is_excluded))
                            else:
                                print(f"Skipping small rectangle from config: {coords}")
            print(f"Loaded existing rectangles from {config_path}")
        except FileNotFoundError:
            print(f"No existing config found at {config_path}")
        except json.JSONDecodeError:
            print(f"Error decoding JSON from {config_path}")
        except Exception as e:
            print(f"An error occurred while loading rectangles: {e}")

    def save_rects(self, event=None):
        try:
            print("Saving rectangles...")
            config_path = self.get_scene_ocr_config()
            print(config_path)
            serializable_rects = []
            for monitor, coords, is_excluded in self.rectangles:
                rect_data = {
                    "monitor": monitor,
                    "coordinates": list(coords),  # Convert tuple to list for JSON
                    "is_excluded": is_excluded
                }
                serializable_rects.append(rect_data)

            print(serializable_rects)
            with open(config_path, 'w', encoding="utf-8") as f:
                json.dump({"scene": sanitize_filename(obs.get_current_scene()), "window": self.window_name, "rectangles": serializable_rects}, f, indent=4)
            print("Rectangles saved.")
            self.result['rectangles'] = self.rectangles.copy()
            self.root.destroy()
        except Exception as e:
            print(f"Failed to save rectangles: {e}")

    def undo_last_rect(self, event=None):
        if self.rectangles and self.drawn_rect_ids:
            last_rect = self.rectangles.pop()
            last_rect_id = self.drawn_rect_ids.pop()

            monitor, coords, is_excluded = last_rect
            self.redo_stack.append((monitor, coords, is_excluded, last_rect_id))

            for canvas in self.canvas_windows.values():
                try:
                    canvas.delete(last_rect_id)
                except tk.TclError:
                    pass
        elif self.current_rect_id is not None:
            for canvas in self.canvas_windows.values():
                try:
                    canvas.delete(self.current_rect_id)
                except tk.TclError:
                    pass
            self.current_rect_id = None
            self.start_x = None
            self.start_y = None


    def redo_last_rect(self, event=None):
        if not self.redo_stack:
            return

        monitor, coords, is_excluded, rect_id = self.redo_stack.pop()
        canvas = self.canvas_windows.get(monitor['index'])
        if canvas:
            x, y, w, h = coords
            outline_color = 'green' if not is_excluded else 'orange'
            new_rect_id = canvas.create_rectangle(x, y, x + w, y + h, outline=outline_color, width=2)
            self.rectangles.append((monitor, coords, is_excluded))
            self.drawn_rect_ids.append(new_rect_id)


    def create_window(self, monitor):
        screenshot = self.sct.grab(monitor)
        img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)

        if img.width != monitor['width']:
            img = img.resize((monitor['width'], monitor['height']), Image.Resampling.LANCZOS)

        AscendingScale = 1.0  # For semi-transparent background
        window = tk.Toplevel(self.root)
        window.geometry(f"{monitor['width']}x{monitor['height']}+{monitor['left']}+{monitor['top']}")
        window.overrideredirect(1)
        window.attributes('-topmost', 1)

        img_tk = ImageTk.PhotoImage(img)

        canvas = tk.Canvas(window, cursor='cross', highlightthickness=0)
        canvas.pack(fill=tk.BOTH, expand=True)
        canvas.image = img_tk
        canvas.bg_img_id = canvas.create_image(0, 0, image=img_tk, anchor=tk.NW)  # Store image ID
        self.canvas_windows[monitor['index']] = canvas

        # Save monitor and window references for refreshing
        self.monitor_windows[monitor['index']] = {
            'window': window,
            'canvas': canvas,
            'bg_img_id': canvas.bg_img_id,
        }

        # Draw existing rectangles for this monitor
        for mon, coords, is_excluded in self.rectangles:
            if mon['index'] == monitor['index']:
                x, y, w, h = coords
                outline_color = 'green' if not is_excluded else 'orange'
                rect_id = canvas.create_rectangle(x, y, x + w, y + h, outline=outline_color, width=2)
                self.drawn_rect_ids.append(rect_id)

        def on_click(event):
            if self.current_rect_id is None:
                self.start_x, self.start_y = event.x, event.y
                outline_color = 'red' if not event.state & 0x0001 else 'purple'  # Shift for exclusion
                self.current_rect_id = canvas.create_rectangle(
                    self.start_x, self.start_y, self.start_x, self.start_y,
                    outline=outline_color, width=2
                )

        def on_drag(event):
            if self.current_rect_id:
                canvas.coords(self.current_rect_id, self.start_x, self.start_y, event.x, event.y)

        def on_release(event):
            if self.current_rect_id:
                end_x, end_y = event.x, event.y
                x1 = min(self.start_x, end_x)
                y1 = min(self.start_y, end_y)
                x2 = max(self.start_x, end_x)
                y2 = max(self.start_y, end_y)
                width = abs(x2 - x1)
                height = abs(y2 - y1)
                if width >= MIN_RECT_WIDTH and height >= MIN_RECT_HEIGHT:
                    is_excluded = bool(event.state & 0x0001)  # Shift key for exclusion
                    canvas.itemconfig(self.current_rect_id, outline='green' if not is_excluded else 'orange')
                    self.rectangles.append((monitor, (x1, y1, width, height), is_excluded))
                    self.drawn_rect_ids.append(self.current_rect_id)
                else:
                    canvas.delete(self.current_rect_id)
                    print(f"Skipping small rectangle: width={width}, height={height}")
                self.current_rect_id = None
                self.start_x = None
                self.start_y = None

        def on_right_click(event):
            item = canvas.find_closest(event.x, event.y)
            if item:
                for idx, rect_id in enumerate(self.drawn_rect_ids):
                    if rect_id == item[0]:
                        canvas.delete(rect_id)
                        # Need to find the corresponding rectangle in self.rectangles and remove it
                        for i, (mon, coords, excluded) in enumerate(self.rectangles):
                            if mon['index'] == monitor['index']:
                                x_r, y_r, w_r, h_r = coords
                                item_coords = canvas.coords(item[0])
                                if x_r == item_coords[0] and y_r == item_coords[1] and x_r + w_r == item_coords[2] and y_r + h_r == item_coords[3]:
                                    del self.rectangles[i]
                                    break
                        del self.drawn_rect_ids[idx]
                        break

        def toggle_image_mode(event=None):
            self.image_mode = not self.image_mode
            if self.image_mode:
                window.attributes("-alpha", 1.0)
            else:
                window.attributes("-alpha", 0.20)


        canvas.bind('<ButtonPress-1>', on_click)
        canvas.bind('<B1-Motion>', on_drag)
        canvas.bind('<ButtonRelease-1>', on_release)
        canvas.bind('<Button-3>', on_right_click)
        window.bind('<Control-s>', self.save_rects)
        window.bind('<Control-z>', self.undo_last_rect)
        window.bind('<s>', self.save_rects)
        window.bind('<z>', self.undo_last_rect)
        window.bind("<Escape>", self.quit_app)
        window.bind("<m>", toggle_image_mode)
        window.bind('<Control-y>', self.redo_last_rect)
        window.bind('<y>', self.redo_last_rect)

    def start(self):
        self.root = tk.Tk()
        self.root.withdraw()

        for monitor in self.monitors:
            monitor['index'] = self.monitors.index(monitor)
            self.create_window(monitor)

        self.root.mainloop()

    def quit_app(self, event=None):
        print("Escape pressed, closing application.")
        self.on_close()

    def on_close(self):
        self.root.destroy()


def run_screen_selector(result, window_name):
    selector = ScreenSelector(result, window_name)
    selector.start()


def get_screen_selection(window_name):
    if not selector_available:
        raise ValueError('tkinter is not installed, unable to open picker')

    with Manager() as manager:
        res = manager.dict()
        process = Process(target=run_screen_selector, args=(res,window_name))

        process.start()
        process.join()

        if 'rectangles' in res:
            return res.copy()
        else:
            return False


if __name__ == "__main__":
    args = sys.argv[1:]
    window_name = args[0] if args else None
    selection = get_screen_selection(window_name)
    if selection:
        print("Selected rectangles:")
        for monitor, coords, is_excluded in selection['rectangles']:
            print(f"Monitor: {monitor}, Coordinates: {coords}, Excluded: {is_excluded}")
    else:
        print("No selection made or process was interrupted.")