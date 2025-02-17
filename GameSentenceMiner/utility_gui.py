import tkinter as tk
from tkinter import ttk

from GameSentenceMiner.configuration import logger


class UtilityApp:
    def __init__(self, root):
        self.root = root

        self.items = []
        self.checkboxes = []
        self.multi_mine_window = None  # Store the multi-mine window reference
        self.checkbox_frame = None

        style = ttk.Style()
        style.configure("TCheckbutton", font=("Arial", 20))  # Change the font and size

    # def show(self):
    #     if self.multi_mine_window is None or not tk.Toplevel.winfo_exists(self.multi_mine_window):
    #         self.multi_mine_window = tk.Toplevel(self.root)
    #         self.multi_mine_window.title("Multi-Mine Window")
    #         self.update_multi_mine_window()
    #
    def show(self):
        """ Open the multi-mine window only if it doesn't exist. """
        if not self.multi_mine_window or not tk.Toplevel.winfo_exists(self.multi_mine_window):
            logger.info("opening multi-mine_window")
            self.multi_mine_window = tk.Toplevel(self.root)
            self.multi_mine_window.title("Multi Mine Window")

            self.multi_mine_window.minsize(800, 400)  # Set a minimum size to prevent shrinking too

            self.checkbox_frame = ttk.Frame(self.multi_mine_window)
            self.checkbox_frame.pack(padx=10, pady=10, fill="both", expand=True)

            # Add existing items
            for text, var, time in self.items:
                self.add_checkbox_to_gui(text, var, time)
        else:
            self.multi_mine_window.deiconify()
            self.multi_mine_window.lift()

    def add_text(self, text, time):
        if text:
            var = tk.BooleanVar()
            self.items.append((text, var, time))

            if len(self.items) > 10:
                if self.checkboxes:
                    self.checkboxes[0].destroy()
                    self.checkboxes.pop(0)
                self.items.pop(0)

            if self.multi_mine_window and tk.Toplevel.winfo_exists(self.multi_mine_window):
                self.add_checkbox_to_gui(text, var, time)

    def add_checkbox_to_gui(self, text, var, time):
        """ Add a single checkbox without repainting everything. """
        if self.checkbox_frame:
            chk = ttk.Checkbutton(self.checkbox_frame, text=f"{time.strftime('%H:%M:%S')} - {text}", variable=var)
            chk.pack(anchor='w')
            self.checkboxes.append(chk)


    # def update_multi_mine_window(self):
    #     for widget in self.multi_mine_window.winfo_children():
    #         widget.destroy()
    #
    #     for i, (text, var, time) in enumerate(self.items):
    #         time: datetime
    #         chk = ttk.Checkbutton(self.checkbox_frame, text=f"{time.strftime('%H:%M:%S')} - {text}", variable=var)
    #         chk.pack(anchor='w')

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
        # if self.multi_mine_window:
        #     for checkbox in self.checkboxes:
        #         checkbox.set(False)


if __name__ == "__main__":
    root = tk.Tk()
    app = UtilityApp(root)
    root.mainloop()
