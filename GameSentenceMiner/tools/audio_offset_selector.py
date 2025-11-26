
# import os
# import sys

# sys_stdout = sys.stdout
# sys_stderr = sys.stderr
# sys.stdout = open(os.devnull, 'w')
# sys.stderr = open(os.devnull, 'w')
# import tkinter as tk
# from tkinter import filedialog, messagebox
# import soundfile as sf
# import numpy as np
# import matplotlib.pyplot as plt
# from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
# import sounddevice as sd

# from GameSentenceMiner.util import ffmpeg


# class AudioOffsetGUI:

#     def __init__(self, master, audio_file_path=None):
#         self.master = master
#         master.title("Audio Offset Adjuster")
#         master.geometry("1000x700")

#         master.tk_setPalette(background='#2E2E2E', foreground='white',
#                              activeBackground='#4F4F4F', activeForeground='white')

#         self.audio_data = None
#         self.samplerate = None
#         self.duration = 0.0

#         self.fig, self.ax = plt.subplots(figsize=(10, 4))
#         self.canvas = FigureCanvasTkAgg(self.fig, master=master)
#         self.canvas_widget = self.canvas.get_tk_widget()
#         self.canvas_widget.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=10, pady=10)

#         plt.style.use('dark_background')
#         self.fig.set_facecolor('#2E2E2E')
#         self.ax.set_facecolor('#2E2E2E')
#         self.ax.tick_params(axis='x', colors='white')
#         self.ax.tick_params(axis='y', colors='white')
#         self.ax.spines['bottom'].set_color('white')
#         self.ax.spines['left'].set_color('white')
#         self.ax.spines['top'].set_color('white')
#         self.ax.spines['right'].set_color('white')
#         self.ax.set_xlabel("Time (s)", color='white')
#         self.ax.set_ylabel("Amplitude", color='white')

#         self.beg_offset_line = None
#         # self.end_offset_line is removed as there's no end slider

#         self.create_widgets()

#         self.load_audio(audio_file_path)


#     def create_widgets(self):
#         control_frame = tk.Frame(self.master, bg='#2E2E2E')
#         control_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=10, padx=10)

#         self.play_button = tk.Button(control_frame, text="Play/Pause Segment", command=self.play_segment, bg='#4F4F4F', fg='white')
#         self.play_button.pack(side=tk.RIGHT, padx=5)

#         self.output_button = tk.Button(control_frame, text="Get Offset", command=self.get_offsets, bg='#4F4F4F', fg='white')
#         self.output_button.pack(side=tk.RIGHT, padx=5)

#         self.beg_offset_label = tk.Label(control_frame, text="Beginning Offset: 0.00s", bg='#2E2E2E', fg='white')
#         self.beg_offset_label.pack(side=tk.LEFT, padx=10)

#         self.end_offset_label = tk.Label(control_frame, text="End Offset: Full Duration", bg='#2E2E2E', fg='white')
#         self.end_offset_label.pack(side=tk.LEFT, padx=10)

#         slider_frame = tk.Frame(self.master, bg='#2E2E2E')
#         slider_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=5, padx=10)

#         beg_slider_label = tk.Label(slider_frame, text="Start Trim:", bg='#2E2E2E', fg='white')
#         beg_slider_label.pack(side=tk.LEFT)
#         self.beg_slider = tk.Scale(slider_frame, from_=0, to=100, orient=tk.HORIZONTAL, resolution=0.5,
#                                    command=self.on_slider_change, bg='#2E2E2E', fg='white', troughcolor='#4F4F4F',
#                                    highlightbackground='#2E2E2E', length=300)
#         self.beg_slider.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=5)

#         # Removed end_slider and its associated label

#     def load_audio(self, file_path):
#         if file_path:
#             try:
#                 self.audio_data, self.samplerate = sf.read(file_path)
#                 if self.audio_data.ndim > 1:
#                     self.audio_data = self.audio_data[:, 0]
#                 self.duration = len(self.audio_data) / self.samplerate
#                 self.plot_waveform()
#                 self.beg_slider.config(to=self.duration)
#                 self.beg_slider.set(0) # Reset start slider to 0
#             except Exception as e:
#                 messagebox.showerror("Error", f"Failed to load audio file: {e}")
#                 self.audio_data = None
#                 self.samplerate = None
#                 self.duration = 0.0

#     def plot_waveform(self):
#         self.ax.clear()
#         if self.audio_data is not None:
#             time = np.linspace(0, self.duration, len(self.audio_data))
#             self.ax.plot(time, self.audio_data, color='#1E90FF')
#             self.ax.set_xlim(0, self.duration)
#             self.ax.set_ylim(np.min(self.audio_data), np.max(self.audio_data))
#             self.ax.set_title("Audio", color='white')

#             if self.beg_offset_line:
#                 self.beg_offset_line.remove()
#             # self.end_offset_line.remove() is removed

#             self.beg_offset_line = self.ax.axvline(self.beg_slider.get(), color='red', linestyle='--', linewidth=2)
#             # The end line is now always at the duration
#             self.ax.axvline(self.duration, color='green', linestyle='--', linewidth=2)

#             self.update_offset_labels()
#         else:
#             self.ax.text(0.5, 0.5, "No audio loaded",
#                          horizontalalignment='center', verticalalignment='center',
#                          transform=self.ax.transAxes, color='white', fontsize=16)

#         self.fig.canvas.draw_idle()

#     def on_slider_change(self, val):
#         if self.audio_data is None:
#             return

#         beg_val = float(self.beg_slider.get())

#         if self.beg_offset_line:
#             self.beg_offset_line.set_xdata([beg_val])

#         self.update_offset_labels()
#         self.fig.canvas.draw_idle()

#     def play_segment(self):
#         if self.audio_data is None:
#             messagebox.showinfo("Play Audio", "No audio file loaded yet.")
#             return

#         if hasattr(self, 'is_playing') and self.is_playing:
#             sd.stop()
#             self.is_playing = False
#             return

#         beg_offset = self.beg_slider.get()
#         end_offset = self.duration # End offset is now always full duration

#         if beg_offset >= end_offset:
#             messagebox.showwarning("Play Audio", "Start offset must be less than end offset.")
#             return

#         start_frame = int(beg_offset * self.samplerate)
#         end_frame = int(end_offset * self.samplerate)

#         if start_frame >= len(self.audio_data) or end_frame <= 0:
#             messagebox.showwarning("Play Audio", "Selected segment is out of audio range.")
#             return

#         segment_to_play = self.audio_data[start_frame:end_frame]

#         try:
#             self.is_playing = True
#             sd.play(segment_to_play, self.samplerate)
#         except Exception as e:
#             self.is_playing = False
#             messagebox.showerror("Audio Playback Error", f"Failed to play audio: {e}")

#     def update_offset_labels(self):
#         if self.beg_offset_line:  # We no longer have an end_offset_line object
#             beg_val = self.beg_offset_line.get_xdata()[0] - 5.0  # Adjusting for the 5 seconds offset
#             self.beg_offset_label.config(text=f"Beginning Offset: {beg_val:.2f}s")

#     def get_offsets(self):
#         if self.audio_data is None:
#             messagebox.showinfo("Offsets", "No audio file loaded yet.")
#             return

#         beg_offset = self.beg_slider.get() - 5.0
#         end_offset = self.duration # End offset is always full duration
#         sys.stdout.close()
#         sys.stderr.close()
#         sys.stdout = sys_stdout
#         sys.stderr = sys_stderr
#         print(f"{beg_offset:.2f}")
#         exit(0)

# def run_audio_offset_gui(path=None, beginning_offset=0, end_offset=None):
#     temp_file_path = os.path.join(os.path.dirname(path), "temp_audio.opus")

#     if os.path.exists(temp_file_path):
#         os.remove(temp_file_path)

#     ffmpeg.trim_audio(path, beginning_offset - 5, end_offset, temp_file_path, True, 0, 0)

#     root = tk.Tk()
#     root.protocol("WM_DELETE_WINDOW", lambda: exit(1))  # Exit when the window is closed
#     app = AudioOffsetGUI(root, audio_file_path=temp_file_path)
#     root.mainloop()


# if __name__ == "__main__":
#     import argparse

#     parser = argparse.ArgumentParser(description="Run Audio Offset GUI")
#     parser.add_argument("--path", type=str, required=True, help="Path to the audio file")
#     parser.add_argument("--beginning_offset", type=float, default=0, help="Beginning offset in seconds")
#     parser.add_argument("--end_offset", type=float, default=None, help="End offset in seconds")

#     args = parser.parse_args()
#     run_audio_offset_gui(path=args.path, beginning_offset=args.beginning_offset, end_offset=args.end_offset)