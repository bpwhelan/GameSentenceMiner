"""
Audio playback utility module for GameSentenceMiner.
Provides safe, non-blocking audio playback functionality with switchable backends.
"""

import io
import numpy as np
import os
import sounddevice as sd
import soundfile as sf
import threading
from abc import ABC, abstractmethod
from typing import Optional, Callable

# Try importing Qt modules, but handle failure gracefully if not available (though they should be)
try:
    from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
    from PyQt6.QtCore import QUrl, QBuffer, QIODevice, QByteArray, QObject, pyqtSignal
except ImportError:
    QMediaPlayer = None

from GameSentenceMiner.util.config.configuration import get_config, logger

class AudioPlayerInterface(ABC):
    """Abstract interface for audio players."""
    
    @abstractmethod
    def __init__(self, finished_callback: Optional[Callable] = None):
        pass

    @abstractmethod
    def play_audio_file(self, audio_path: str) -> bool:
        pass

    @abstractmethod
    def play_audio_data(self, data: np.ndarray, samplerate: int) -> bool:
        pass

    @abstractmethod
    def stop_audio(self):
        pass

    @abstractmethod
    def cleanup(self):
        pass

    @abstractmethod
    def get_current_time(self) -> float:
        pass
        
    @property
    @abstractmethod
    def is_playing(self) -> bool:
        pass


class SoundDeviceAudioPlayer(AudioPlayerInterface):
    """
    A safe, non-blocking audio player using the sounddevice library.
    """
    
    def __init__(self, finished_callback: Optional[Callable] = None):
        self.current_audio_stream: Optional[sd.OutputStream] = None
        self.current_audio_data: Optional[np.ndarray] = None
        self.current_audio_samplerate: Optional[int] = None
        self._is_playing: bool = False
        self._audio_position: int = 0
        self.finished_callback = finished_callback
        self._lock = threading.Lock()
    
    @property
    def is_playing(self) -> bool:
        return self._is_playing

    def play_audio_file(self, audio_path: str) -> bool:
        try:
            if self.is_playing:
                self.stop_audio()
            
            data, samplerate = sf.read(audio_path)
            return self.play_audio_data(data, samplerate)
        except Exception as e:
            logger.error(f"Failed to play audio file {audio_path}: {e}")
            self._cleanup_stream()
            return False
    
    def play_audio_data(self, data: np.ndarray, samplerate: int) -> bool:
        try:
            with self._lock:
                data = data.astype('float32')
                self.current_audio_data = data
                self.current_audio_samplerate = samplerate
                self._audio_position = 0
                
                def audio_callback(outdata, frames, time, status):
                    if status:
                        print(f"Audio callback status: {status}")
                    
                    start_frame = self._audio_position
                    end_frame = start_frame + frames
                    
                    if end_frame <= len(data):
                        if data.ndim == 1:
                            outdata[:, 0] = data[start_frame:end_frame]
                        else:
                            outdata[:] = data[start_frame:end_frame]
                        self._audio_position = end_frame
                    else:
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
                        
                        self._schedule_finish()
                
                stream = sd.OutputStream(
                    samplerate=samplerate,
                    channels=data.shape[1] if data.ndim > 1 else 1,
                    callback=audio_callback
                )
                
                self.current_audio_stream = stream
                self._is_playing = True
                stream.start()
                return True
                
        except Exception as e:
            logger.error(f"Failed to play audio data: {e}")
            self._cleanup_stream()
            return False
    
    def stop_audio(self):
        with self._lock:
            if self.current_audio_stream and self.is_playing:
                try:
                    self.current_audio_stream.stop()
                except Exception:
                    pass
            self._cleanup_stream()
    
    def _schedule_finish(self):
        def finish_task():
            self._audio_finished()
        threading.Thread(target=finish_task, daemon=True).start()
    
    def _audio_finished(self):
        with self._lock:
            self._cleanup_stream()
            if self.finished_callback:
                try:
                    self.finished_callback()
                except Exception as e:
                    logger.error(f"Error in audio finished callback: {e}")
    
    def _cleanup_stream(self):
        if self.current_audio_stream:
            try:
                self.current_audio_stream.close()
            except Exception:
                pass
        
        self.current_audio_stream = None
        self._is_playing = False
        self.current_audio_data = None
        self.current_audio_samplerate = None
        self._audio_position = 0
    
    def cleanup(self):
        self.stop_audio()
        self.finished_callback = None

    def get_current_time(self) -> float:
        if not self.is_playing or self.current_audio_samplerate is None:
            return 0.0
        return self._audio_position / self.current_audio_samplerate


class QtPlayerSignals(QObject):
    finished = pyqtSignal()


class QtAudioPlayer(AudioPlayerInterface):
    """
    Audio player using PyQt6.QtMultimedia.
    """
    def __init__(self, finished_callback: Optional[Callable] = None):
        if QMediaPlayer is None:
            raise ImportError("PyQt6.QtMultimedia is not available")
            
        self.finished_callback = finished_callback
        self.player = QMediaPlayer()
        self.audio_output = QAudioOutput()
        self.player.setAudioOutput(self.audio_output)
        
        # Keep reference to buffer to prevent garbage collection
        self.buffer: Optional[QBuffer] = None
        
        # Signals
        self._signals = QtPlayerSignals()
        if finished_callback:
            self._signals.finished.connect(finished_callback)
            
        self.player.mediaStatusChanged.connect(self._on_media_status_changed)
        self.player.errorOccurred.connect(self._on_error)

    @property
    def is_playing(self) -> bool:
        return self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState

    def play_audio_file(self, audio_path: str) -> bool:
        self.stop_audio()
        if not os.path.exists(audio_path):
             logger.error(f"QtAudioPlayer: File not found {audio_path}")
             return False

        try:
            # Try to decode with soundfile first as it supports more formats (like opus) 
            # than default Windows media foundation used by Qt
            data, samplerate = sf.read(audio_path)
            return self.play_audio_data(data, samplerate)
        except Exception as e:
            logger.warning(f"QtAudioPlayer: Failed to decode with soundfile ({e}), trying direct playback...")
            try:
                self.player.setSource(QUrl.fromLocalFile(audio_path))
                self.player.play()
                return True
            except Exception as e2:
                logger.error(f"QtAudioPlayer: Direct playback also failed: {e2}")
                return False

    def play_audio_data(self, data: np.ndarray, samplerate: int) -> bool:
        self.stop_audio()
        try:
            # Convert numpy array to WAV bytes in memory
            # QtMultimedia supports playing from QIODevice (like QBuffer)
            # but it needs a format it understands (like WAV or encoded data).
            # Raw PCM via QAudioSink is another option but QMediaPlayer is easier if we wrap in WAV.
            
            byte_io = io.BytesIO()
            # soundfile.write expects data in proper shape. 
            # sounddevice player cast to float32. SF handles various types.
            # Let's ensure it's float32 for consistency or whatever SF defaults to.
            sf.write(byte_io, data, samplerate, format='WAV', subtype='PCM_16')
            byte_io.seek(0)
            
            # Create QByteArray and QBuffer
            qbytes = QByteArray(byte_io.read())
            self.buffer = QBuffer(qbytes)
            self.buffer.open(QIODevice.OpenModeFlag.ReadOnly)
            
            self.player.setSourceDevice(self.buffer, QUrl("memory.wav"))
            self.player.play()
            return True
        except Exception as e:
            logger.error(f"QtAudioPlayer data error: {e}")
            return False

    def stop_audio(self):
        if self.is_playing:
            self.player.stop()
        self.player.setSource(QUrl())
        if self.buffer:
            self.buffer.close()
            self.buffer = None

    def cleanup(self):
        self.stop_audio()
        self.player.deleteLater()
        self.audio_output.deleteLater()
        self.finished_callback = None

    def get_current_time(self) -> float:
        return self.player.position() / 1000.0

    def _on_media_status_changed(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self.stop_audio()
            self._signals.finished.emit()

    def _on_error(self):
        logger.error(f"QtAudioPlayer Error: {self.player.errorString()}")
        self.stop_audio()


class AudioPlayer(AudioPlayerInterface):
    """
    Proxy class that delegates to the configured implementation.
    """
    def __init__(self, finished_callback: Optional[Callable] = None):
        config = get_config()
        backend = getattr(config.advanced, 'audio_backend', 'sounddevice')
        
        self.impl: AudioPlayerInterface
        if backend == 'qt6' and QMediaPlayer is not None:
            self.impl = QtAudioPlayer(finished_callback)
        else:
            self.impl = SoundDeviceAudioPlayer(finished_callback)

    def play_audio_file(self, audio_path: str) -> bool:
        return self.impl.play_audio_file(audio_path)

    def play_audio_data(self, data: np.ndarray, samplerate: int) -> bool:
        return self.impl.play_audio_data(data, samplerate)

    def stop_audio(self):
        self.impl.stop_audio()

    def cleanup(self):
        self.impl.cleanup()

    def get_current_time(self) -> float:
        return self.impl.get_current_time()

    @property
    def is_playing(self) -> bool:
        return self.impl.is_playing
