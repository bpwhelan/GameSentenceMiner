from multiprocessing import Process, Manager
import mss
from PIL import Image

try:
    from PIL import ImageTk
    import tkinter as tk
    selector_available = True
except:
    selector_available = False


class ScreenSelector:
    def __init__(self, result):
        self.sct = mss.mss()
        self.monitors = self.sct.monitors[1:]
        self.root = None
        self.result = result

    def on_select(self, monitor, coordinates):
        self.result['monitor'] = monitor
        self.result['coordinates'] = coordinates
        self.root.destroy()

    def create_window(self, monitor):
        screenshot = self.sct.grab(monitor)
        img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)

        if img.width != monitor['width']:
            img = img.resize((monitor['width'], monitor['height']), Image.Resampling.LANCZOS)

        window = tk.Toplevel(self.root)
        window.geometry(f"{monitor['width']}x{monitor['height']}+{monitor['left']}+{monitor['top']}")
        window.overrideredirect(1)
        window.attributes('-topmost', 1)

        img_tk = ImageTk.PhotoImage(img)

        canvas = tk.Canvas(window, cursor='cross', highlightthickness=0)
        canvas.pack(fill=tk.BOTH, expand=True)
        canvas.image = img_tk
        canvas.create_image(0, 0, image=img_tk, anchor=tk.NW)

        start_x, start_y, rect = None, None, None

        def on_click(event):
            nonlocal start_x, start_y, rect
            start_x, start_y = event.x, event.y
            rect = canvas.create_rectangle(start_x, start_y, start_x, start_y, outline='red')

        def on_drag(event):
            nonlocal rect, start_x, start_y
            if rect:
                canvas.coords(rect, start_x, start_y, event.x, event.y)

        def on_release(event):
            nonlocal start_x, start_y
            end_x, end_y = event.x, event.y

            x1 = min(start_x, end_x)
            y1 = min(start_y, end_y)
            x2 = max(start_x, end_x)
            y2 = max(start_y, end_y)

            self.on_select(monitor, (x1, y1, x2 - x1, y2 - y1))

        canvas.bind('<ButtonPress-1>', on_click)
        canvas.bind('<B1-Motion>', on_drag)
        canvas.bind('<ButtonRelease-1>', on_release)

    def start(self):
        self.root = tk.Tk()
        self.root.withdraw()

        for monitor in self.monitors:
            self.create_window(monitor)

        self.root.mainloop()
        self.root.update()


def run_screen_selector(result):
    selector = ScreenSelector(result)
    selector.start()


def get_screen_selection():
    if not selector_available:
        raise ValueError('tkinter or PIL with tkinter support are not installed, unable to open picker')

    with Manager() as manager:
        res = manager.dict()
        process = Process(target=run_screen_selector, args=(res,))

        process.start()
        process.join()

        if 'monitor' in res and 'coordinates' in res:
            return res.copy()
        else:
            return False

if __name__ == "__main__":
    selection = get_screen_selection()
    if selection:
        print(f"Selected monitor: {selection['monitor']}")
        print(f"Selected coordinates: {selection['coordinates']}")
    else:
        print("No selection made or process was interrupted.")