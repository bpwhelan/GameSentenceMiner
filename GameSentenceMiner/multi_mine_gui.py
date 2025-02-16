import tkinter as tk
from datetime import datetime
from tkinter import ttk, messagebox

from GameSentenceMiner.configuration import logger


class TextCheckboxApp:
    def __init__(self, root):
        self.root = root

        self.items = []
        self.multi_mine_window = None  # Store the multi-mine window reference

        style = ttk.Style()
        style.configure("TCheckbutton", font=("Arial", 20))  # Change the font and size


    def add_text(self, text, time):
        if text:
            var = tk.BooleanVar()
            # var.trace_add("write", self.validate_checkboxes)
            self.items.append((text, var, time))
            if self.multi_mine_window and tk.Toplevel.winfo_exists(self.multi_mine_window):
                self.update_multi_mine_window()

    def show(self):
        if self.multi_mine_window is None or not tk.Toplevel.winfo_exists(self.multi_mine_window):
            self.multi_mine_window = tk.Toplevel(self.root)
            self.multi_mine_window.title("Multi-Mine Window")
            self.update_multi_mine_window()
        else:
            self.update_multi_mine_window()
            self.multi_mine_window.deiconify()
            self.multi_mine_window.lift()

    def update_multi_mine_window(self):
        for widget in self.multi_mine_window.winfo_children():
            widget.destroy()

        frame = ttk.Frame(self.multi_mine_window)
        frame.pack(padx=10, pady=10, fill=tk.BOTH, expand=True)

        for i, (text, var, time) in enumerate(self.items):
            time: datetime
            chk = ttk.Checkbutton(frame, text=f"{time.strftime('%H:%M:%S')} - {text}", variable=var)
            chk.pack(anchor='w')

    def get_selected_lines(self):
        filtered_items = [text for text, var, _ in self.items if var.get()]
        return filtered_items if len(filtered_items) >= 2 else []

    def get_selected_times(self):
        filtered_times = [time for _, var, time in self.items if var.get()]

        if len(filtered_times) >= 2:
            logger.info(filtered_times)
            # Find the index of the last checked checkbox
            last_checked_index = max(i for i, (_, var, _) in enumerate(self.items) if var.get())

            # Get the time AFTER the last checked checkbox, if it exists
            if last_checked_index + 1 < len(self.items):
                next_time = self.items[last_checked_index + 1][2]
            else:
                next_time = 0

            return filtered_times[0], next_time

        return None

    def lines_selected(self):
        filter_times = [time for _, var, time in self.items if var.get()]
        if len(filter_times) >= 2:
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
        for _, var, _ in self.items:
            var.set(False)
        if self.multi_mine_window:
            self.update_multi_mine_window()


if __name__ == "__main__":
    root = tk.Tk()
    app = TextCheckboxApp(root)
    root.mainloop()
