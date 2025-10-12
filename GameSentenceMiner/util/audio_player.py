"""
Audio playback utility module for GameSentenceMiner.
Provides safe, non-blocking audio playback functionality.
"""

import threading
from typing import Optional, Callable
import sounddevice as sd
import soundfile as sf
import numpy as np


class AudioPlayer:
    """
    A safe, non-blocking audio player class that handles audio stream management.
    """
    
    def __init__(self, finished_callback: Optional[Callable] = None):
        """
        Initialize the audio player.
        
        Args:
            finished_callback: Optional callback function to call when audio finishes playing
        """
        self.current_audio_stream: Optional[sd.OutputStream] = None
        self.current_audio_data: Optional[np.ndarray] = None
        self.current_audio_samplerate: Optional[int] = None
        self.is_playing: bool = False
        self._audio_position: int = 0
        self.finished_callback = finished_callback
        self._lock = threading.Lock()
    
    def play_audio_file(self, audio_path: str) -> bool:
        """
        Play an audio file. If already playing, stop the current playback.
        
        Args:
            audio_path: Path to the audio file to play
            
        Returns:
            True if playback started successfully, False otherwise
        """
        try:
            # If audio is currently playing, stop it
            if self.is_playing:
                self.stop_audio()
                return True
            
            # Load audio data
            data, samplerate = sf.read(audio_path)
            return self.play_audio_data(data, samplerate)
            
        except Exception as e:
            print(f"Failed to play audio file {audio_path}: {e}")
            self._cleanup_stream()
            return False
    
    def play_audio_data(self, data: np.ndarray, samplerate: int) -> bool:
        """
        Play audio from numpy array data.
        
        Args:
            data: Audio data as numpy array
            samplerate: Sample rate of the audio data
            
        Returns:
            True if playback started successfully, False otherwise
        """
        try:
            with self._lock:
                # Ensure data is float32 for sounddevice playback
                data = data.astype('float32')
                
                # Store audio data
                self.current_audio_data = data
                self.current_audio_samplerate = samplerate
                self._audio_position = 0
                
                # Create audio callback
                def audio_callback(outdata, frames, time, status):
                    if status:
                        print(f"Audio callback status: {status}")
                    
                    # Calculate how much data we need for this callback
                    start_frame = self._audio_position
                    end_frame = start_frame + frames
                    
                    if end_frame <= len(data):
                        # We have enough data
                        if data.ndim == 1:
                            outdata[:, 0] = data[start_frame:end_frame]
                        else:
                            outdata[:] = data[start_frame:end_frame]
                        self._audio_position = end_frame
                    else:
                        # We've reached the end
                        remaining_frames = len(data) - start_frame
                        if remaining_frames > 0:
                            if data.ndim == 1:
                                outdata[:remaining_frames, 0] = data[start_frame:]
                                outdata[remaining_frames:, 0] = 0
                            else:
                                outdata[:remaining_frames] = data[start_frame:]
                                outdata[remaining_frames:] = 0
                        else:
                            outdata.fill(0)
                        
                        # Schedule cleanup
                        self._schedule_finish()
                
                # Create and start audio stream
                stream = sd.OutputStream(
                    samplerate=samplerate,
                    channels=data.shape[1] if data.ndim > 1 else 1,
                    callback=audio_callback
                )
                
                self.current_audio_stream = stream
                self.is_playing = True
                stream.start()
                
                return True
                
        except Exception as e:
            print(f"Failed to play audio data: {e}")
            self._cleanup_stream()
            return False
    
    def stop_audio(self):
        """Stop the currently playing audio."""
        with self._lock:
            if self.current_audio_stream and self.is_playing:
                try:
                    self.current_audio_stream.stop()
                except Exception:
                    pass
            self._cleanup_stream()
    
    def _schedule_finish(self):
        """Schedule the finish callback to be called."""
        # Use threading to avoid blocking the audio callback
        def finish_task():
            self._audio_finished()
        
        threading.Thread(target=finish_task, daemon=True).start()
    
    def _audio_finished(self):
        """Called when audio playback finishes."""
        with self._lock:
            self._cleanup_stream()
            if self.finished_callback:
                try:
                    self.finished_callback()
                except Exception as e:
                    print(f"Error in audio finished callback: {e}")
    
    def _cleanup_stream(self):
        """Clean up the current audio stream."""
        if self.current_audio_stream:
            try:
                self.current_audio_stream.close()
            except Exception:
                pass
        
        self.current_audio_stream = None
        self.is_playing = False
        self.current_audio_data = None
        self.current_audio_samplerate = None
        self._audio_position = 0
    
    def cleanup(self):
        """Clean up all resources."""
        self.stop_audio()
        self.finished_callback = None


def create_safe_audio_callback(data: np.ndarray, position_tracker: dict, finish_callback: Callable):
    """
    Create a safe audio callback function for use with sounddevice.
    
    Args:
        data: Audio data array
        position_tracker: Dictionary to track playback position (mutable)
        finish_callback: Function to call when playback finishes
    
    Returns:
        Audio callback function
    """
    def audio_callback(outdata, frames, time, status):
        if status:
            print(f"Audio callback status: {status}")
        
        # Calculate how much data we need for this callback
        start_frame = position_tracker.get('position', 0)
        end_frame = start_frame + frames
        
        if end_frame <= len(data):
            # We have enough data
            if data.ndim == 1:
                outdata[:, 0] = data[start_frame:end_frame]
            else:
                outdata[:] = data[start_frame:end_frame]
            position_tracker['position'] = end_frame
        else:
            # We've reached the end
            remaining_frames = len(data) - start_frame
            if remaining_frames > 0:
                if data.ndim == 1:
                    outdata[:remaining_frames, 0] = data[start_frame:]
                    outdata[remaining_frames:, 0] = 0
                else:
                    outdata[:remaining_frames] = data[start_frame:]
                    outdata[remaining_frames:] = 0
            else:
                outdata.fill(0)
            
            # Schedule cleanup
            threading.Thread(target=finish_callback, daemon=True).start()
    
    return audio_callback