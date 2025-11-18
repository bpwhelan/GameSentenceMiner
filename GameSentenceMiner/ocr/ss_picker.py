# import tkinter as tk
# from tkinter import Canvas
# from PIL import Image, ImageTk
# import mss
# import mss.tools
# import io

# class ScreenCropper:
#     def __init__(self):
#         self.main_monitor = None
#         self.root = None
#         self.canvas = None
#         self.captured_image = None
#         self.tk_image = None
#         self.start_x = None
#         self.start_y = None
#         self.end_x = None
#         self.end_y = None
#         self.rect_id = None
#         self.cropped_image = None
#         self.monitor_geometry = None

#     def grab_all_monitors(self):
#         try:
#             with mss.mss() as sct:
#                 all_monitors_bbox = sct.monitors[0]
#                 self.main_monitor = sct.monitors[1]
#                 self.monitor_geometry = {
#                     'left': all_monitors_bbox['left'],
#                     'top': all_monitors_bbox['top'],
#                     'width': all_monitors_bbox['width'],
#                     'height': all_monitors_bbox['height']
#                 }
#                 sct_grab = sct.grab(all_monitors_bbox)

#                 img_bytes = mss.tools.to_png(sct_grab.rgb, sct_grab.size)
#                 self.captured_image = Image.open(io.BytesIO(img_bytes))

#             print("All monitors captured successfully.")
#         except Exception as e:
#             print(f"An error occurred during screen capture: {e}")
#             self.captured_image = None
#             self.monitor_geometry = None

#     def _on_button_press(self, event):
#         self.start_x = self.end_x = event.x
#         self.start_y = self.end_y = event.y

#         if self.rect_id:
#             self.canvas.delete(self.rect_id)
#         self.rect_id = self.canvas.create_rectangle(self.start_x, self.start_y,
#                                                     self.end_x, self.end_y,
#                                                     outline="red", width=2)

#     def _on_mouse_drag(self, event):
#         self.end_x = event.x
#         self.end_y = event.y
#         self.canvas.coords(self.rect_id, self.start_x, self.start_y,
#                            self.end_x, self.end_y)

#     def _on_button_release(self, event):
#         self.end_x = event.x
#         self.end_y = event.y

#         x1 = min(self.start_x, self.end_x)
#         y1 = min(self.start_y, self.end_y)
#         x2 = max(self.start_x, self.end_x)
#         y2 = max(self.start_y, self.end_y)

#         if (x2 - x1) > 0 and (y2 - y1) > 0:
#             self.cropped_image = self.captured_image.crop((x1, y1, x2, y2))
#             print(f"Selection made: ({x1}, {y1}) to ({x2}, {y2})")
#         else:
#             print("No valid selection made (area was too small).")
#             self.cropped_image = None

#         self.root.destroy()

#     def _on_enter(self, event):
#         print(event)
#         print("Enter key pressed, grabbing main monitor area.")
#         self.cropped_image = self.captured_image.crop((self.main_monitor['left'], self.main_monitor['top'],
#                                                   self.main_monitor['left'] + self.main_monitor['width'],
#                                                    self.main_monitor['top'] + self.main_monitor['height']))
#         self.root.destroy()


#     def show_image_and_select_box(self):
#         if self.captured_image is None or self.monitor_geometry is None:
#             print("No image or monitor geometry to display. Capture all monitors first.")
#             return

#         self.root = tk.Tk()
#         self.root.attributes('-topmost', True)
#         self.root.overrideredirect(True)

#         window_width = self.monitor_geometry['width']
#         window_height = self.monitor_geometry['height']
#         window_x = self.monitor_geometry['left']
#         window_y = self.monitor_geometry['top']

#         self.root.geometry(f"{window_width}x{window_height}+{window_x}+{window_y}")

#         self.tk_image = ImageTk.PhotoImage(self.captured_image)

#         self.canvas = Canvas(self.root, cursor="cross", highlightthickness=0)
#         self.canvas.pack(fill=tk.BOTH, expand=True)

#         self.canvas.create_image(0, 0, anchor="nw", image=self.tk_image)

#         self.canvas.bind("<Button-1>", self._on_button_press)
#         self.canvas.bind("<B1-Motion>", self._on_mouse_drag)
#         self.canvas.bind("<ButtonRelease-1>", self._on_button_release)


#         self.root.mainloop()

#     def get_cropped_image(self):
#         return self.cropped_image

#     def run(self, return_main_monitor=False):
#         self.grab_all_monitors()
#         if return_main_monitor and self.captured_image:
#             return self.captured_image.crop((self.main_monitor['left'], self.main_monitor['top'],
#                                                   self.main_monitor['left'] + self.main_monitor['width'],
#                                                    self.main_monitor['top'] + self.main_monitor['height']))
#         if self.captured_image and self.monitor_geometry:
#             self.show_image_and_select_box()
#             return self.get_cropped_image()
#         return None

# if __name__ == "__main__":
#     cropper = ScreenCropper()
#     cropped_img = cropper.run()

#     if cropped_img:
#         print("Image cropped successfully. Displaying cropped image...")
#         cropped_img.show()
#     else:
#         print("No image was cropped.")
