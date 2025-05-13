import tkinter as tk
from PIL import Image, ImageTk
import subprocess
import os
import shutil
import sys

from GameSentenceMiner.configuration import get_temporary_directory, logger
from GameSentenceMiner.ffmpeg import ffmpeg_base_command_list
from GameSentenceMiner.util import sanitize_filename


def extract_frames(video_path, timestamp, temp_dir):
    frame_paths = []
    start_time = timestamp_to_seconds(timestamp)
    command = ffmpeg_base_command_list + [
        "-y",
        "-ss", str(start_time),
        "-i", video_path,
        "-vf", f"fps=1/{0.25}",
        "-vframes", "20",
        os.path.join(temp_dir, "frame_%02d.png")
    ]
    logger.debug(" ".join(command))
    subprocess.run(command, check=True, capture_output=True)
    for i in range(1, 21):
        frame_paths.append(os.path.join(temp_dir, f"frame_{i:02d}.png"))
    return frame_paths

def timestamp_to_seconds(timestamp):
    hours, minutes, seconds = map(int, timestamp.split(':'))
    return hours * 3600 + minutes * 60 + seconds

def display_images(image_paths):
    window = tk.Tk()
    window.title("Image Selector")
    selected_path = tk.StringVar()
    image_widgets = []

    def on_image_click(event):
        widget = event.widget
        index = image_widgets.index(widget)
        selected_path.set(image_paths[index])
        window.quit()

    for i, path in enumerate(image_paths):
        img = Image.open(path)
        img.thumbnail((300, 300))
        img_tk = ImageTk.PhotoImage(img)
        label = tk.Label(window, image=img_tk)
        label.image = img_tk
        label.grid(row=i // 5, column=i % 5, padx=5, pady=5)
        label.bind("<Button-1>", on_image_click)
        image_widgets.append(label)

    window.mainloop()
    return selected_path.get()

def run_extraction_and_display(video_path, timestamp_str):
    temp_dir = os.path.join(get_temporary_directory(), "screenshot_frames",  sanitize_filename(video_path.split('.mkv')[0]))
    image_paths = extract_frames(video_path, timestamp_str, temp_dir)
    if image_paths:
        selected_image_path = display_images(image_paths)
        if selected_image_path:
            print(selected_image_path)

def main():
    if len(sys.argv) != 3:
        print("Usage: python script.py <video_path> <timestamp>")
        sys.exit(1)
    video_path = sys.argv[1]
    timestamp_str = sys.argv[2]
    logger.debug(f"Running extraction and display for video: {video_path} at timestamp: {timestamp_str}")
    try:
        run_extraction_and_display(video_path, timestamp_str)
    except Exception as e:
        logger.debug("Error during extraction and display: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
