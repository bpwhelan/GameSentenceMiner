# # TODO REMOVE THIS, DEPRECATED

# import os
# import sys
# import subprocess

# import tkinter as tk
# from PIL import Image, ImageTk
# from GameSentenceMiner.util.gsm_utils import sanitize_filename
# from GameSentenceMiner.util.configuration import get_temporary_directory, logger, ffmpeg_base_command_list
# from GameSentenceMiner.util import ffmpeg

# # Suppress stdout and stderr during imports
# sys_stdout = sys.stdout
# sys_stderr = sys.stderr
# sys.stdout = open(os.devnull, 'w')
# sys.stderr = open(os.devnull, 'w')

# def extract_frames(video_path, timestamp, temp_dir, mode):
#     frame_paths = []
#     timestamp_number = float(timestamp)
#     golden_frame_index = 1  # Default to the first frame
#     golden_frame = None
#     video_duration = ffmpeg.get_video_duration(video_path)

#     if mode == 'middle':
#         timestamp_number = max(0.0, timestamp_number - 2.5)
#     elif mode == 'end':
#         timestamp_number = max(0.0, timestamp_number - 5.0)

#     if video_duration is not None and timestamp_number > video_duration:
#         logger.debug(f"Timestamp {timestamp_number} exceeds video duration {video_duration}.")
#         return None

#     try:
#         command = ffmpeg_base_command_list + [
#             "-y",
#             "-ss", str(timestamp_number),
#             "-i", video_path,
#             "-vf", f"fps=1/{0.25}",
#             "-vframes", "20",
#             os.path.join(temp_dir, "frame_%02d.png")
#         ]
#         subprocess.run(command, check=True, capture_output=True)
#         for i in range(1, 21):
#             if os.path.exists(os.path.join(temp_dir, f"frame_{i:02d}.png")):
#                 frame_paths.append(os.path.join(temp_dir, f"frame_{i:02d}.png"))

#         if mode == "beginning":
#             golden_frame = frame_paths[0]
#         if mode == "middle":
#             golden_frame = frame_paths[len(frame_paths) // 2]
#         if mode == "end":
#             golden_frame = frame_paths[-1]
#     except subprocess.CalledProcessError as e:
#         logger.debug(f"Error extracting frames: {e}")
#         logger.debug(f"Command was: {' '.join(command)}")
#         logger.debug(f"FFmpeg output:\n{e.stderr.decode()}")
#         return None
#     except Exception as e:
#         logger.debug(f"An error occurred: {e}")
#         return None
#     return frame_paths, golden_frame

# def timestamp_to_seconds(timestamp):
#     hours, minutes, seconds = map(int, timestamp.split(':'))
#     return hours * 3600 + minutes * 60 + seconds

# def display_images(image_paths, golden_frame):
#     window = tk.Tk()
#     window.configure(bg="black")  # Set the background color to black
#     window.title("Image Selector")
#     selected_path = tk.StringVar()
#     image_widgets = []

#     def on_image_click(event):
#         widget = event.widget
#         index = image_widgets.index(widget)
#         selected_path.set(image_paths[index])
#         window.quit()

#     for i, path in enumerate(image_paths):
#         img = Image.open(path)
#         img.thumbnail((img.width / 8, img.height / 8))
#         img_tk = ImageTk.PhotoImage(img)
#         if golden_frame and path == golden_frame:
#             label = tk.Label(window, image=img_tk, borderwidth=5, relief="solid")
#             label.config(highlightbackground="yellow", highlightthickness=5)
#         else:
#             label = tk.Label(window, image=img_tk)
#         label.image = img_tk
#         label.grid(row=i // 5, column=i % 5, padx=5, pady=5)
#         label.bind("<Button-1>", on_image_click)  # Bind click event to the label
#         image_widgets.append(label)

#     window.attributes("-topmost", True)
#     window.mainloop()
#     return selected_path.get()

# def run_extraction_and_display(video_path, timestamp_str, mode):
#     temp_dir = os.path.join(get_temporary_directory(False), "screenshot_frames", sanitize_filename(os.path.splitext(os.path.basename(video_path))[0]))
#     os.makedirs(temp_dir, exist_ok=True)
#     image_paths, golden_frame = extract_frames(video_path, timestamp_str, temp_dir, mode)
#     if image_paths:
#         selected_image_path = display_images(image_paths, golden_frame)
#         if selected_image_path:
#             sys.stdout.close()
#             sys.stderr.close()
#             sys.stdout = sys_stdout
#             sys.stderr = sys_stderr
#             print(selected_image_path)
#         else:
#             logger.debug("No image was selected.")
#     else:
#         logger.debug("Frame extraction failed.")

# def main():


#     # if len(sys.argv) != 3:
#     #     print("Usage: python script.py <video_path> <timestamp>")
#     #     sys.exit(1)
#     try:
#         video_path = sys.argv[1]
#         timestamp_str = sys.argv[2]
#         mode = sys.argv[3] if len(sys.argv) > 3 else "beginning"
#         run_extraction_and_display(video_path, timestamp_str, mode)
#     except Exception as e:
#         logger.debug(e)
#         sys.exit(1)


# if __name__ == "__main__":
#     main()
