import ctypes
import sys
import tkinter as tk
from tkinter import messagebox, simpledialog
import json
from pathlib import Path
import time  # Optional: for debugging timing if needed
from PIL import Image, ImageTk
import io
import keyboard

from GameSentenceMiner import obs, util

class DynamicAreaSelector(tk.Tk):
    def __init__(self, window_title):
        super().__init__()
        self.title("Dynamic Area Selector")
        self.attributes('-fullscreen', True)
        self.attributes("-topmost", True)  # Make the window always on top
        self.attributes("-alpha", 0.20)

        self.window_title = window_title
        self.rects = []
        self.start_x = None
        self.start_y = None
        self.current_rect_id = None
        self.drawn_rect_ids = []
        self.saved_rect_coords = []
        self.excluded_rect_coords = []  # New list for excluded rectangles
        self.drawn_excluded_rect_ids = []  # New list for excluded rect ids
        self.image_mode = False
        self.image_item = None
        self.image_tk = None
        self.canvas = None

        if not self.initialize_ui():
            self.after(0, self.destroy)
            return

        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Button-3>", self.on_right_click)  # Bind right-click
        self.bind("<Control-s>", self.save_rects_event)
        self.bind("<Control-z>", self.undo_last_rect)
        self.bind("<Escape>", self.quit_app)
        self.bind("<Control-i>", self.toggle_image_mode)

        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def initialize_ui(self):
        try:
            self.canvas = tk.Canvas(self, highlightthickness=0)
            self.canvas.pack(fill=tk.BOTH, expand=True)

            self.load_and_draw_existing_rects()
            return True

        except Exception as e:
            messagebox.showerror("Initialization Error", f"Failed: {e}")
            print(f"Initialization error details: {e}")
            return False

    def load_and_draw_existing_rects(self):
        if self.get_scene_ocr_config().exists():
            try:
                with open(self.get_scene_ocr_config(), 'r') as f:
                    config_data = json.load(f)
                    loaded_rects = []
                    loaded_excluded_rects = []
                    for r in config_data.get("rectangles", []):
                        try:
                            coords = tuple(map(float, r))
                            if len(coords) == 4:
                                loaded_rects.append(coords)
                            else:
                                print(f"Skipping invalid rectangle data: {r}")
                        except (ValueError, TypeError) as coord_err:
                            print(f"Skipping invalid coordinate data in rectangle {r}: {coord_err}")

                    for r in config_data.get("excluded_rectangles", []):
                        try:
                            coords = tuple(map(float, r))
                            if len(coords) == 4:
                                loaded_excluded_rects.append(coords)
                            else:
                                print(f"Skipping invalid excluded rectangle data: {r}")
                        except (ValueError, TypeError) as coord_err:
                            print(f"Skipping invalid coordinate data in excluded rectangle {r}: {coord_err}")

                    self.saved_rect_coords = loaded_rects
                    self.excluded_rect_coords = loaded_excluded_rects
                    for rect_id in self.drawn_rect_ids:
                        self.canvas.delete(rect_id)
                    for rect_id in self.drawn_excluded_rect_ids:
                        self.canvas.delete(rect_id)
                    self.drawn_rect_ids = []
                    self.drawn_excluded_rect_ids = []

                    for rect in self.saved_rect_coords:
                        x1, y1, x2, y2 = rect
                        rect_id = self.canvas.create_rectangle(x1, y1, x2, y2, outline='blue', width=2)
                        self.drawn_rect_ids.append(rect_id)

                    for rect in self.excluded_rect_coords:
                        x1, y1, x2, y2 = rect
                        rect_id = self.canvas.create_rectangle(x1, y1, x2, y2, outline='orange', width=2)
                        self.drawn_excluded_rect_ids.append(rect_id)

            except json.JSONDecodeError:
                messagebox.showwarning("Config Load Warning", f"Could not parse {self.get_scene_ocr_config()}. Starting with no rectangles.")
                self.saved_rect_coords = []
                self.excluded_rect_coords = []
            except FileNotFoundError:
                self.saved_rect_coords = []
                self.excluded_rect_coords = []
            except Exception as e:
                messagebox.showerror("Config Load Error", f"Error loading rectangles: {e}")
                self.saved_rect_coords = []
                self.excluded_rect_coords = []

    def on_press(self, event):
        if self.current_rect_id is None:
            self.start_x = self.canvas.canvasx(event.x)
            self.start_y = self.canvas.canvasy(event.y)
            outline_color = 'red' if not event.state & 0x0001 else 'purple'  # check if shift is pressed
            self.current_rect_id = self.canvas.create_rectangle(
                self.start_x, self.start_y, self.start_x, self.start_y,
                outline=outline_color, width=2
            )

    def on_drag(self, event):
        if self.current_rect_id is not None:
            cur_x = self.canvas.canvasx(event.x)
            cur_y = self.canvas.canvasy(event.y)
            self.canvas.coords(self.current_rect_id, self.start_x, self.start_y, cur_x, cur_y)

    def on_release(self, event):
        if self.current_rect_id is not None:
            end_x = self.canvas.canvasx(event.x)
            end_y = self.canvas.canvasy(event.y)
            x1 = min(self.start_x, end_x)
            y1 = min(self.start_y, end_y)
            x2 = max(self.start_x, end_x)
            y2 = max(self.start_y, end_y)

            self.canvas.coords(self.current_rect_id, x1, y1, x2, y2)
            if event.state & 0x0001:  # shift is pressed
                self.canvas.itemconfig(self.current_rect_id, outline='orange')
                self.excluded_rect_coords.append((x1, y1, x2, y2))
                self.drawn_excluded_rect_ids.append(self.current_rect_id)
            else:
                self.canvas.itemconfig(self.current_rect_id, outline='green')
                self.saved_rect_coords.append((x1, y1, x2, y2))
                self.drawn_rect_ids.append(self.current_rect_id)

            self.current_rect_id = None
            self.start_x = None
            self.start_y = None

    def save_rects(self):
        try:
            serializable_rects = [
                tuple(map(int, rect)) for rect in self.saved_rect_coords
            ]
            serializable_excluded_rects = [
                tuple(map(int, rect)) for rect in self.excluded_rect_coords
            ]
            with open(self.get_scene_ocr_config(), 'w') as f:
                json.dump({"window": self.window_title if self.window_title else "", "scene": obs.get_current_scene(), "rectangles": serializable_rects, "excluded_rectangles": serializable_excluded_rects}, f, indent=4)
            for rect_id in self.drawn_rect_ids:
                if self.canvas.winfo_exists():
                    try:
                        self.canvas.itemconfig(rect_id, outline='blue')
                    except tk.TclError:
                        pass
            for rect_id in self.drawn_excluded_rect_ids:
                if self.canvas.winfo_exists():
                    try:
                        self.canvas.itemconfig(rect_id, outline='orange')
                    except tk.TclError:
                        pass
            print("Rectangles saved.")
            self.on_close()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save rectangles: {e}")

    def save_rects_event(self, event=None):
        self.save_rects()

    def undo_last_rect(self, event=None):
        if self.saved_rect_coords and self.drawn_rect_ids:
            self.saved_rect_coords.pop()
            last_rect_id = self.drawn_rect_ids.pop()
            if self.canvas.winfo_exists():
                self.canvas.delete(last_rect_id)
        elif self.excluded_rect_coords and self.drawn_excluded_rect_ids:
            self.excluded_rect_coords.pop()
            last_rect_id = self.drawn_excluded_rect_ids.pop()
            if self.canvas.winfo_exists():
                self.canvas.delete(last_rect_id)
        elif self.current_rect_id is not None:
            if self.canvas.winfo_exists():
                self.canvas.delete(self.current_rect_id)
            self.current_rect_id = None
            self.start_x = None
            self.start_y = None

    def quit_app(self, event=None):
        print("Escape pressed, closing application.")
        self.on_close()

    def on_close(self):
        self.destroy()

    def get_scene_ocr_config(self):
        app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
        ocr_config_dir = app_dir / "ocr_config"
        ocr_config_dir.mkdir(parents=True, exist_ok=True)
        scene = util.sanitize_filename(obs.get_current_scene())
        config_path = ocr_config_dir / f"{scene}.json"
        return config_path

    def on_right_click(self, event):
        """Deletes the rectangle clicked with the right mouse button."""
        item = self.canvas.find_closest(event.x, event.y)

        if item:
            if item[0] in self.drawn_rect_ids:  # Check if it's a saved rectangle
                index = self.drawn_rect_ids.index(item[0])
                self.canvas.delete(item[0])
                del self.drawn_rect_ids[index]
                del self.saved_rect_coords[index]
            elif item[0] in self.drawn_excluded_rect_ids:
                index = self.drawn_excluded_rect_ids.index(item[0])
                self.canvas.delete(item[0])
                del self.drawn_excluded_rect_ids[index]
                del self.excluded_rect_coords[index]

    def setup_hotkey(self):
        keyboard.add_hotkey('F13', self.lift_window)  # Example hotkey

    def lift_window(self):
        self.lift()  # Bring the window to the front

    def toggle_image_mode(self, event=None):
        self.image_mode = not self.image_mode
        if self.image_mode:
            self.attributes("-alpha", 1.0)
            self.load_image_from_obs()
        else:
            self.attributes("-alpha", 0.20)
            if self.image_item:
                self.canvas.delete(self.image_item)
                self.image_item = None
                self.image_tk = None

    def load_image_from_obs(self):
        try:
            image_path = obs.get_screenshot()
            image = Image.open(image_path)
            self.image_tk = ImageTk.PhotoImage(image)
            self.image_item = self.canvas.create_image(0, 0, anchor=tk.NW, image=self.image_tk)
            self.canvas.tag_lower(self.image_item)
        except Exception as e:
            messagebox.showerror("Image Load Error", f"Failed to load image from OBS: {e}")

def run_screen_picker(window_title):
    app = DynamicAreaSelector(window_title)
    app.mainloop()

if __name__ == "__main__":
    args = sys.argv[1:]
    obs.connect_to_obs()
    run_screen_picker(args[0] if len(args) > 0 else None)