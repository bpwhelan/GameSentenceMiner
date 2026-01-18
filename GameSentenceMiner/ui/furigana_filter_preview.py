# import tkinter as tk
# from tkinter import ttk
# from PIL import Image, ImageTk
# import threading

# import regex

# from GameSentenceMiner import obs
# from GameSentenceMiner.util.configuration import logger, get_overlay_config
# from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, OneOCR

# def get_overlay_screenshot() -> Image.Image:
#     """
#     Captures a screenshot from the configured overlay monitor using mss.
    
#     Returns:
#         A PIL Image object of the screenshot from the overlay monitor.
#     """
#     try:
#         import mss
#         overlay_config = get_overlay_config()
#         monitor_index = overlay_config.monitor_to_capture
        
#         with mss.mss() as sct:
#             # mss.monitors[0] is all monitors combined, mss.monitors[1] is the first monitor
#             # So we need to add 1 to the monitor_index to get the correct monitor
#             monitor = sct.monitors[monitor_index + 1]
#             screenshot = sct.grab(monitor)
            
#             # Convert to PIL Image
#             img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
#             logger.info(f"Screenshot captured from monitor {monitor_index + 1} ({img.width}x{img.height})")
#             return img
            
#     except ImportError:
#         logger.error("mss library not found. Please install it to use overlay functionality.")
#         raise
#     except IndexError:
#         logger.error(f"Monitor index {monitor_index + 1} not found. Available monitors: {len(sct.monitors) - 1}")
#         raise
#     except Exception as e:
#         logger.error(f"Failed to capture overlay screenshot: {e}")
#         raise

# def get_ocr_results_from_image(image_obj: Image.Image) -> tuple:
#     """
#     This is the function where you will plug in your OCR logic.

#     Args:
#         image_obj: A PIL Image object of the screenshot (used by your actual OCR call).

#     Returns:
#         A tuple containing the OCR results from both engines.
#     """
#     lens = GoogleLens()
#     oneocr = OneOCR()
#     oneocr_res = oneocr(image_obj, return_dict=True)
#     res = lens(image_obj, return_coords=True)
    
#     return res[2], oneocr_res[3]


# class FuriganaFilterVisualizer:
#     def __init__(self, master, image: Image.Image, current_furigana_sensitivity: int = 0):
#         self.master = master
#         self.image = image
#         self.ocr1_result = None
#         self.ocr2_result = None
#         self.current_ocr = 1
#         self.title_prefix = "Furigana Filter Visualizer"
#         self.master.title(f"{self.title_prefix} - Lens")

#         self.words_data = []
#         self.lines_data = []
#         self.drawn_rects = []

#         main_frame = tk.Frame(master)
#         main_frame.pack(fill=tk.BOTH, expand=True)

#         self.photo_image = ImageTk.PhotoImage(self.image)
#         self.canvas = tk.Canvas(main_frame, width=self.image.width, height=self.image.height)
#         self.canvas.pack(side=tk.TOP, fill=tk.BOTH, expand=True)
#         self.canvas.create_image(0, 0, image=self.photo_image, anchor=tk.NW)

#         self.loading_bg = self.canvas.create_rectangle(
#             self.image.width/2 - 100, self.image.height/2 - 25,
#             self.image.width/2 + 100, self.image.height/2 + 25,
#             fill="black", outline="white", width=2
#         )
#         self.loading_text = self.canvas.create_text(
#             self.image.width / 2, self.image.height / 2,
#             text="Loading OCR data...", fill="white", font=("Helvetica", 16)
#         )

#         self.control_frame = tk.Frame(main_frame, padx=10, pady=10)
#         self.control_frame.pack(side=tk.BOTTOM, fill=tk.X)

#         ttk.Label(self.control_frame, text="Furigana Filter Sensitivity:").pack(side=tk.LEFT, padx=(0, 10))

#         self.slider = ttk.Scale(
#             self.control_frame, from_=0, to=100, orient=tk.HORIZONTAL, command=self.update_filter_visualization
#         )
#         self.slider.set(current_furigana_sensitivity)
#         self.slider.pack(side=tk.LEFT, fill=tk.X, expand=True)

#         self.slider_value_label = ttk.Label(self.control_frame, text=f"{self.slider.get():.0f} px", width=6)
#         self.slider_value_label.pack(side=tk.LEFT, padx=(10, 0))
        
#         self.swap_button = ttk.Button(self.control_frame, text="Switch to OneOCR", command=self.swap_ocr)
#         self.swap_button.pack(side=tk.LEFT, padx=(10, 0))
            
#         self.ok_button = ttk.Button(self.control_frame, text="OK", command=self.on_ok)
#         self.ok_button.pack(side=tk.LEFT, padx=(10, 0))
        
#         self.slider.config(state=tk.DISABLED)
#         self.swap_button.config(state=tk.DISABLED)
#         self.ok_button.config(state=tk.DISABLED)

#         self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
#         self.master.protocol("WM_DELETE_WINDOW", self.on_ok)
    
#     def set_title_prefix(self, prefix: str):
#         """Set the title prefix and update the current title."""
#         self.title_prefix = prefix
#         ocr_name = "Lens" if self.current_ocr == 1 else "OneOCR"
#         self.master.title(f"{self.title_prefix} - {ocr_name}")

#     def update_with_ocr_data(self, ocr1_result, ocr2_result):
#         """Called by the background thread to populate the GUI with OCR data."""
#         self.ocr1_result = ocr1_result
#         self.ocr2_result = ocr2_result

#         # Remove loading message
#         self.canvas.delete(self.loading_bg)
#         self.canvas.delete(self.loading_text)

#         if not self.ocr1_result:
#             logger.error("OCR processing failed or returned no data.")
#             self.canvas.create_text(
#                 self.image.width / 2, self.image.height / 2,
#                 text="OCR Failed!", fill="red", font=("Helvetica", 16)
#             )
#             # Still enable OK button to allow closing
#             self.ok_button.config(state=tk.NORMAL)
#             return

#         # Enable controls
#         self.slider.config(state=tk.NORMAL)
#         self.ok_button.config(state=tk.NORMAL)
#         if self.ocr2_result:
#             self.swap_button.config(state=tk.NORMAL)
        
#         # Process and display initial data
#         self.pre_process_word_geometries()
#         self.update_filter_visualization(self.slider.get())

#     def on_ok(self):
#         print(f"RESULT:[{self.slider.get():.0f}]")
#         self.master.destroy()

#     def swap_ocr(self):
#         self.current_ocr = 2 if self.current_ocr == 1 else 1
#         # Change to oneocr or lens, in title too
#         if self.current_ocr == 1:
#             self.swap_button.config(text="Switch to OneOCR")
#             self.master.title(f"{self.title_prefix} - Lens")
#         else:
#             self.swap_button.config(text="Switch to Lens")
#             self.master.title(f"{self.title_prefix} - OneOCR")
#         self.pre_process_word_geometries()
#         self.update_filter_visualization(self.slider.get())

#     def pre_process_word_geometries(self):
#         """
#         Parses the OCR result structure (supports both original and new JSON formats),
#         calculates absolute pixel values, and stores them for high-performance updates.
#         """
#         img_w, img_h = self.image.size
#         logger.info(f"Processing word geometries for image size {img_w}x{img_h}...")

#         # Select the current OCR result
#         ocr_result = self.ocr1_result if self.current_ocr == 1 else self.ocr2_result
#         if not ocr_result:
#             return
#         self.words_data.clear()
#         self.lines_data.clear()

#         # Try to detect the format: oneocr has 'lines' as a top-level key
#         if 'lines' in ocr_result:
#             for line in ocr_result.get('lines', []):
#                 for word in line.get('words', []):
#                     try:
#                         bbox = word['bounding_rect']
#                         x1 = bbox['x1']
#                         y1 = bbox['y1']
#                         x2 = bbox['x3']
#                         y2 = bbox['y3']
#                         px_w = abs(x2 - x1)
#                         px_h = abs(y2 - y1)
#                         self.words_data.append({
#                             'text': word.get('text', ''),
#                             'px_w': px_w,
#                             'px_h': px_h,
#                             'coords': (x1, y1, x2, y2)
#                         })
#                     except Exception as e:
#                         logger.warning(f"Skipping malformed word data (new format): {e}. Data: {word}")
#                         continue
#                 try:
#                     bbox = line['bounding_rect']
#                     x1 = bbox['x1']
#                     y1 = bbox['y1']
#                     x2 = bbox['x3']
#                     y2 = bbox['y3']
#                     px_w = abs(x2 - x1)
#                     px_h = abs(y2 - y1)
#                     self.lines_data.append({
#                         'text': line.get('text', ''),
#                         'px_w': px_w,
#                         'px_h': px_h,
#                         'coords': (x1, y1, x2, y2)
#                     })
#                 except Exception as e:
#                     logger.warning(f"Skipping malformed line data (new format): {e}. Data: {line}")
#                     continue
#         else:
#             # Lens format (nested paragraphs/lines/words)
#             text_layout = ocr_result.get('objects_response', {}).get('text', {}).get('text_layout', {})
#             if not text_layout:
#                 logger.error("Could not find 'text_layout' in the OCR response.")
#                 return
#             for paragraph in text_layout.get('paragraphs', []):
#                 for line in paragraph.get('lines', []):
#                     for word in line.get('words', []):
#                         try:
#                             bbox_pct = word['geometry']['bounding_box']
#                             width_pct = bbox_pct['width']
#                             height_pct = bbox_pct['height']
#                             top_left_x_pct = bbox_pct['center_x'] - (width_pct / 2)
#                             top_left_y_pct = bbox_pct['center_y'] - (height_pct / 2)
#                             px_w = width_pct * img_w
#                             px_h = height_pct * img_h
#                             x1 = top_left_x_pct * img_w
#                             y1 = top_left_y_pct * img_h
#                             x2 = x1 + px_w
#                             y2 = y1 + px_h
#                             self.words_data.append({
#                                 'text': word.get('plain_text', ''),
#                                 'px_w': px_w,
#                                 'px_h': px_h,
#                                 'coords': (x1, y1, x2, y2)
#                             })
#                         except (KeyError, TypeError) as e:
#                             logger.warning(f"Skipping malformed word data (orig format): {e}. Data: {word}")
#                             continue
#                     try:
#                         line_bbox = line['geometry']['bounding_box']
#                         width_pct = line_bbox['width']
#                         height_pct = line_bbox['height']
#                         top_left_x_pct = line_bbox['center_x'] - (width_pct / 2)
#                         top_left_y_pct = line_bbox['center_y'] - (height_pct / 2)
#                         px_w = width_pct * img_w
#                         px_h = height_pct * img_h
#                         x1 = top_left_x_pct * img_w
#                         y1 = top_left_y_pct * img_h
#                         x2 = x1 + px_w
#                         y2 = y1 + px_h
#                         self.lines_data.append({
#                             'text': ''.join([w.get('plain_text', '') for w in line.get('words', [])]),
#                             'px_w': px_w,
#                             'px_h': px_h,
#                             'coords': (x1, y1, x2, y2)
#                         })
#                     except (KeyError, TypeError) as e:
#                         logger.warning(f"Skipping malformed line data (orig format): {e}. Data: {line}")
#                         continue
#         logger.info(f"Successfully pre-processed {len(self.lines_data)} lines.")
        

#     def update_filter_visualization(self, slider_value):
#         """
#         Called on every slider move. Clears old rectangles and draws new ones
#         for words that pass the sensitivity filter.
#         """
#         sensitivity = float(slider_value)
#         # Only update the label if it exists (GUI is fully initialized)
#         if hasattr(self, 'slider_value_label'):
#             self.slider_value_label.config(text=f"{sensitivity:.0f} px")

#         for rect_id in self.drawn_rects:
#             self.canvas.delete(rect_id)
#         self.drawn_rects.clear()

#         # Set color based on current OCR: green for Lens (OCR 1), blue for OneOCR (OCR 2)
#         outline_color = 'green' if self.current_ocr == 1 else 'blue'
        
#         for line_data in self.lines_data:
#             if line_data['px_w'] > sensitivity and line_data['px_h'] > sensitivity:
#                 x1, y1, x2, y2 = line_data['coords']
#                 rect_id = self.canvas.create_rectangle(
#                     x1, y1, x2, y2, outline=outline_color, width=2
#                 )
#                 self.drawn_rects.append(rect_id)

# def scale_down_width_height(width, height):
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

# def main():
#     import sys
    
#     # Parse command line arguments
#     current_furigana_sensitivity = 0
#     use_overlay = False
    
#     if len(sys.argv) > 1:
#         # Check if any argument is "overlay" or "--overlay"
#         args = sys.argv[1:]
#         if "overlay" in args or "--overlay" in args:
#             use_overlay = True
#             # Remove overlay flags and use remaining numeric argument as sensitivity
#             numeric_args = [arg for arg in args if arg not in ["overlay", "--overlay"] and arg.isdigit()]
#             if numeric_args:
#                 current_furigana_sensitivity = int(numeric_args[0])
#         else:
#             # Assume first argument is sensitivity
#             try:
#                 current_furigana_sensitivity = int(args[0])
#             except ValueError:
#                 logger.warning(f"Invalid sensitivity value: {args[0]}. Using default value 0.")

#     """Main execution function."""
#     if use_overlay:
#         logger.info("Using overlay mode - capturing from configured monitor...")
#         try:
#             screenshot_img = get_overlay_screenshot()
#         except Exception as e:
#             logger.error(f"Failed to get overlay screenshot: {e}")
#             return
#     else:
#         try:
#             logger.info("Connecting to OBS...")
#             obs.connect_to_obs_sync()
#         except Exception as e:
#             logger.error(f"Failed to connect to OBS. Please ensure OBS is running and the WebSocket server is enabled. Error: {e}")
#             return

#         logger.info("Taking OBS screenshot...")
#         screenshot_img = obs.get_screenshot_PIL(compression=90, img_format='jpg')

#         if not screenshot_img:
#             logger.error("Failed to get screenshot from OBS.")
#             return

#     # Scale down the image for performance
#     screenshot_img = screenshot_img.resize(scale_down_width_height(screenshot_img.width, screenshot_img.height), Image.LANCZOS)
    
#     source_type = "overlay monitor" if use_overlay else "OBS"
#     logger.info(f"Screenshot received from {source_type} ({screenshot_img.width}x{screenshot_img.height}).")

#     root = tk.Tk()
#     app = FuriganaFilterVisualizer(root, screenshot_img, current_furigana_sensitivity)
    
#     # Update window title to reflect source
#     if use_overlay:
#         overlay_config = get_overlay_config()
#         monitor_num = overlay_config.monitor_to_capture + 1
#         app.set_title_prefix(f"Furigana Filter Visualizer - Overlay Monitor {monitor_num}")

#     def ocr_worker():
#         logger.info("Starting OCR process in background thread...")
#         try:
#             ocr1_data, ocr2_data = get_ocr_results_from_image(screenshot_img)
#             root.after(0, app.update_with_ocr_data, ocr1_data, ocr2_data)
#         except Exception as e:
#             logger.error(f"Error in OCR background thread: {e}")
#             root.after(0, app.update_with_ocr_data, None, None)

#     threading.Thread(target=ocr_worker, daemon=True).start()

#     root.mainloop()

# if __name__ == "__main__":
#     main()