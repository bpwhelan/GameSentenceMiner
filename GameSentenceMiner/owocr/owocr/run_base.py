import sys
import signal
import time
import threading
from pathlib import Path
import queue
import io
import re
import logging
import inspect
import os
import json
import collections
from dataclasses import asdict
import importlib
import urllib.request

import numpy as np
import pyperclipfix
import psutil
import asyncio
import websockets
import socket
import socketserver

from PIL import Image, ImageDraw
from loguru import logger
from pynput import keyboard
from desktop_notifier import DesktopNotifierSync, Urgency

from .ocr import *
from .config import config
from .screen_coordinate_picker import get_screen_selection, terminate_selector_if_running

try:
    import win32gui
    import win32ui
    import win32api
    import win32con
    import win32process
    import win32clipboard
    import pywintypes
    import ctypes
except ImportError:
    pass

try:
    import objc
    import platform
    from AppKit import NSData, NSImage, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSZeroPoint, NSZeroRect, NSCompositingOperationCopy, NSPasteboard, \
                       NSPasteboardTypeTIFF
    from Quartz import CGWindowListCreateImageFromArray, kCGWindowImageBoundsIgnoreFraming, CGRectMake, CGRectNull, CGMainDisplayID, CGWindowListCopyWindowInfo, \
                       CGWindowListCreateDescriptionFromArray, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow, \
                       kCGWindowName, kCGNullWindowID, CGImageGetWidth, CGImageGetHeight, CGDataProviderCopyData, CGImageGetDataProvider, CGImageGetBytesPerRow, \
                       kCGWindowImageNominalResolution
    from Foundation import NSString
    from ScreenCaptureKit import SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCCaptureResolutionNominal
except ImportError:
    pass

if sys.platform == 'linux' and os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland':
    from . import wayland_mss_shim
    mss = wayland_mss_shim.MSSModuleShim()
else:
    import mss


class ClipboardThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.delay_seconds = config.get_general('delay_seconds')
        self.last_update = time.time()

    def are_images_identical(self, img1, img2):
        if None in (img1, img2):
            return img1 == img2

        img1 = np.array(img1)
        img2 = np.array(img2)

        return (img1.shape == img2.shape) and (img1 == img2).all()

    def normalize_macos_clipboard(self, img):
        ns_data = NSData.dataWithBytes_length_(img, len(img))
        ns_image = NSImage.alloc().initWithData_(ns_data)

        new_image = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
            None,  # Set to None to create a new bitmap
            int(ns_image.size().width),
            int(ns_image.size().height),
            8,  # Bits per sample
            4,  # Samples per pixel (R, G, B, A)
            True,  # Has alpha
            False,  # Is not planar
            NSDeviceRGBColorSpace,
            0,  # Automatically compute bytes per row
            32  # Bits per pixel (8 bits per sample * 4 samples per pixel)
        )

        context = NSGraphicsContext.graphicsContextWithBitmapImageRep_(new_image)
        NSGraphicsContext.setCurrentContext_(context)

        ns_image.drawAtPoint_fromRect_operation_fraction_(
            NSZeroPoint,
            NSZeroRect,
            NSCompositingOperationCopy,
            1.0
        )

        return bytearray(new_image.TIFFRepresentation())

    def process_message(self, hwnd: int, msg: int, wparam: int, lparam: int):
        WM_CLIPBOARDUPDATE = 0x031D
        timestamp = time.time()
        if msg == WM_CLIPBOARDUPDATE and timestamp - self.last_update > 1 and not paused.is_set():
            self.last_update = timestamp
            wait_counter = 0
            while True:
                try:
                    win32clipboard.OpenClipboard()
                    break
                except pywintypes.error:
                    pass
                if wait_counter == 3:
                    return 0
                time.sleep(0.1)
                wait_counter += 1
            try:
                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_BITMAP) and win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_DIB):
                    img = win32clipboard.GetClipboardData(win32clipboard.CF_DIB)
                    image_queue.put((img, False, None))
            except pywintypes.error:
                pass
            try:
                win32clipboard.CloseClipboard()
            except pywintypes.error:
                pass
        return 0

    def create_window(self):
        className = 'ClipboardHook'
        wc = win32gui.WNDCLASS()
        wc.lpfnWndProc = self.process_message
        wc.lpszClassName = className
        wc.hInstance = win32api.GetModuleHandle(None)
        class_atom = win32gui.RegisterClass(wc)
        return win32gui.CreateWindow(class_atom, className, 0, 0, 0, 0, 0, 0, 0, wc.hInstance, None)

    def run(self):
        if sys.platform == 'win32':
            hwnd = self.create_window()
            self.thread_id = win32api.GetCurrentThreadId()
            ctypes.windll.user32.AddClipboardFormatListener(hwnd)
            win32gui.PumpMessages()
        else:
            if sys.platform == 'linux' and os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland':
                import subprocess
                socket_path = Path('/tmp/owocr_clipboard.sock')

                if socket_path.exists():
                    try:
                        test_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        test_socket.connect(str(socket_path))
                        test_socket.close()
                        exit_with_error('Unix domain socket is already in use')
                    except ConnectionRefusedError:
                        socket_path.unlink()

                try:
                    self.wl_paste = subprocess.Popen(
                        ['wl-paste', '-t', 'image', '-w', 'nc', '-U', socket_path],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE
                    )
                    time.sleep(0.5)
                except (subprocess.CalledProcessError, FileNotFoundError):
                    exit_with_error('wl-paste not found')
                return_code = self.wl_paste.poll()
                if return_code is not None and return_code != 0:
                    stderr_output = self.wl_paste.stderr.read()
                    exit_with_error(f'wl-paste exited with return code {return_code}: {stderr_output.decode().strip()}')

                server = socketserver.UnixStreamServer(str(socket_path), UnixSocketRequestHandler)
                server.timeout = 0.5

                while not terminated.is_set():
                    server.handle_request()
                self.wl_paste.kill()
                server.server_close()
            else:
                is_macos = sys.platform == 'darwin'
                if is_macos:
                    pasteboard = NSPasteboard.generalPasteboard()
                    count = pasteboard.changeCount()
                else:
                    from PIL import ImageGrab

            process_clipboard = False
            img = None

            while not terminated.is_set():
                if paused.is_set():
                    sleep_time = 0.5
                    process_clipboard = False
                else:
                    sleep_time = self.delay_seconds
                    if is_macos:
                        with objc.autorelease_pool():
                            old_count = count
                            count = pasteboard.changeCount()
                            if process_clipboard and count != old_count:
                                wait_counter = 0
                                while len(pasteboard.types()) == 0 and wait_counter < 3:
                                    time.sleep(0.1)
                                    wait_counter += 1
                                if NSPasteboardTypeTIFF in pasteboard.types():
                                    img = self.normalize_macos_clipboard(pasteboard.dataForType_(NSPasteboardTypeTIFF))
                                    image_queue.put((img, False, None))
                    else:
                        old_img = img
                        try:
                            img = ImageGrab.grabclipboard()
                        except:
                            pass
                        else:
                            if (process_clipboard and isinstance(img, Image.Image) and \
                                (not self.are_images_identical(img, old_img))):
                                image_queue.put((img, False, None))

                    process_clipboard = True

                if not terminated.is_set():
                    time.sleep(sleep_time)


class DirectoryWatcher(threading.Thread):
    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.delay_seconds = config.get_general('delay_seconds')
        self.last_update = time.time()
        self.allowed_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp')

    def get_path_key(self, path):
        return path, path.lstat().st_mtime

    def run(self):
        old_paths = set()
        for path in self.path.iterdir():
            if path.suffix.lower() in self.allowed_extensions:
                old_paths.add(self.get_path_key(path))

        while not terminated.is_set():
            if paused.is_set():
                sleep_time = 0.5
            else:
                sleep_time = self.delay_seconds
                for path in self.path.iterdir():
                    if path.suffix.lower() in self.allowed_extensions:
                        path_key = self.get_path_key(path)
                        if path_key not in old_paths:
                            old_paths.add(path_key)

                            if not paused.is_set():
                                image_queue.put((path, False, None))

            if not terminated.is_set():
                time.sleep(sleep_time)


class WebsocketServerThread(threading.Thread):
    def __init__(self, read):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, text):
        for client in self.clients:
            await client.send(text)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                if self.read and not paused.is_set():
                    image_queue.put((message, False, None))
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    def send_text(self, text):
        return asyncio.run_coroutine_threadsafe(self.send_text_coroutine(text), self.loop)

    def stop_server(self):
        try:
            self.loop.call_soon_threadsafe(self._stop_event.set)
        except RuntimeError:
            pass

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            websocket_port = config.get_general('websocket_port')
            self.server = start_server = websockets.serve(self.server_handler, '0.0.0.0', websocket_port, max_size=1000000000)
            try:
                async with start_server:
                    await stop_event.wait()
            except OSError:
                exit_with_error(f"Couldn't start websocket server. Make sure port {websocket_port} is not already in use")
        asyncio.run(main())


class UnixSocketRequestHandler(socketserver.BaseRequestHandler):
    def handle(self):
        conn = self.request
        conn.settimeout(0.5)
        img = bytearray()
        magic = b'IMG_SIZE'
        try:
            img_size = sys.maxsize
            header = conn.recv(len(magic))
            if header == magic:
                size_bytes = conn.recv(8)
                if not size_bytes or len(size_bytes) < 8:
                    raise ValueError
                img_size = int.from_bytes(size_bytes)
            else:
                img.extend(header)
            bytes_received = 0
            while bytes_received < img_size:
                remaining = img_size - bytes_received
                chunk_size = min(4096, remaining)
                data = conn.recv(chunk_size)
                if not data:
                    break
                img.extend(data)
                bytes_received += len(data)
        except (TimeoutError, ValueError):
            pass

        try:
            if not paused.is_set() and img:
                image_queue.put((img, False, None))
                conn.sendall(b'True')
            else:
                conn.sendall(b'False')
        except:
            pass


class TextFiltering:
    def __init__(self):
        self.language = config.get_general('language')
        self.json_output = config.get_general('output_format') == 'json'
        self.frame_stabilization = 0 if config.get_general('screen_capture_delay_seconds') == -1 else config.get_general('screen_capture_frame_stabilization')
        self.line_recovery = not self.json_output and config.get_general('screen_capture_line_recovery')
        self.furigana_filter = config.get_general('furigana_filter')
        self.debug_filtering = config.get_general('uwu')
        self.last_frame_data = (None, None)
        self.last_last_frame_data = (None, None)
        self.stable_frame_data = None
        self.last_frame_text = []
        self.last_last_frame_text = []
        self.stable_frame_text = []
        self.processed_stable_frame = False
        self.frame_stabilization_timestamp = 0
        self.cj_regex = re.compile(r'[\u3041-\u3096\u30A1-\u30FA\u4E01-\u9FFF]')
        self.kanji_regex = re.compile(r'[\u4E00-\u9FFF]')
        self.regex = self._get_regex()
        self.manual_regex_filter = self._get_manual_regex_filter()
        self.kana_variants = {
            'ぁ': ['ぁ', 'あ'], 'あ': ['ぁ', 'あ'],
            'ぃ': ['ぃ', 'い'], 'い': ['ぃ', 'い'],
            'ぅ': ['ぅ', 'う'], 'う': ['ぅ', 'う'],
            'ぇ': ['ぇ', 'え'], 'え': ['ぇ', 'え'],
            'ぉ': ['ぉ', 'お'], 'お': ['ぉ', 'お'],
            'ァ': ['ァ', 'ア'], 'ア': ['ァ', 'ア'],
            'ィ': ['ィ', 'イ'], 'イ': ['ィ', 'イ'],
            'ゥ': ['ゥ', 'ウ'], 'ウ': ['ゥ', 'ウ'],
            'ェ': ['ェ', 'エ'], 'エ': ['ェ', 'エ'],
            'ォ': ['ォ', 'オ'], 'オ': ['ォ', 'オ'],
            'ゃ': ['ゃ', 'や'], 'や': ['ゃ', 'や'],
            'ゅ': ['ゅ', 'ゆ'], 'ゆ': ['ゅ', 'ゆ'],
            'ょ': ['ょ', 'よ'], 'よ': ['ょ', 'よ'],
            'ャ': ['ャ', 'ヤ'], 'ヤ': ['ャ', 'ヤ'],
            'ュ': ['ュ', 'ユ'], 'ユ': ['ュ', 'ユ'],
            'ョ': ['ョ', 'ヨ'], 'ヨ': ['ョ', 'ヨ'],
            'っ': ['っ', 'つ'], 'つ': ['っ', 'つ'],
            'ッ': ['ッ', 'ツ'], 'ツ': ['ッ', 'ツ'],
            'ゎ': ['ゎ', 'わ'], 'わ': ['ゎ', 'わ'],
            'ヮ': ['ヮ', 'ワ'], 'ワ': ['ヮ', 'ワ']
        }

    def _get_regex(self):
        if self.language == 'ja':
            return self.cj_regex
        elif self.language == 'zh':
            return self.kanji_regex
        elif self.language == 'ko':
            return re.compile(r'[\uAC00-\uD7AF]')
        elif self.language == 'ar':
            return re.compile(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
        elif self.language == 'ru':
            return re.compile(r'[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u1C80-\u1C8F]')
        elif self.language == 'el':
            return re.compile(r'[\u0370-\u03FF\u1F00-\u1FFF]')
        elif self.language == 'he':
            return re.compile(r'[\u0590-\u05FF\uFB1D-\uFB4F]')
        elif self.language == 'th':
            return re.compile(r'[\u0E00-\u0E7F]')
        else:
            # Latin Extended regex for many European languages/English
            return re.compile(
            r'[a-zA-Z\u00C0-\u00FF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]')

    def _get_manual_regex_filter(self):
        manual_regex_filter = config.get_general('screen_capture_regex_filter')
        if manual_regex_filter:
            try:
                return re.compile(manual_regex_filter)
            except re.error as e:
                logger.warning(f'Invalid screen capture regex filter: {e}')
        return None

    def _convert_small_kana_to_big(self, text):
        converted_text = ''.join(self.kana_variants.get(char, [char])[-1] for char in text)
        return converted_text

    def get_line_text(self, line):
        if line.text is not None:
            return line.text
        text_parts = []
        for w in line.words:
            text_parts.append(w.text)
            if w.separator is not None:
                text_parts.append(w.separator)
            else:
                text_parts.append(' ')
        return ''.join(text_parts).strip()

    def _normalize_line_for_comparison(self, line_text):
        if not line_text.replace('\n', ''):
            return ''
        filtered_text = ''.join(self.regex.findall(line_text))
        if self.language == 'ja':
            filtered_text = self._convert_small_kana_to_big(filtered_text)
        return filtered_text

    def find_changed_lines(self, pil_image, current_result):
        if self.frame_stabilization == 0:
            changed_lines = self._find_changed_lines_impl(current_result, self.last_frame_data[1])
            if changed_lines is None:
                return 0, 0, None
            changed_lines_count = len(changed_lines)
            self.last_frame_data = (pil_image, current_result)
            if changed_lines_count and not self.json_output:
                changed_regions_image = self._create_changed_regions_image(pil_image, changed_lines, None, None)
                if not changed_regions_image:
                    logger.warning('Error occurred while creating the differential image')
                    return 0, 0, None
                return changed_lines_count, 0, changed_regions_image
            else:
                return changed_lines_count, 0, None

        changed_lines_stabilization = self._find_changed_lines_impl(current_result, self.last_frame_data[1])
        if changed_lines_stabilization is None:
            return 0, 0, None

        frames_match = len(changed_lines_stabilization) == 0

        logger.debug(f"Frames match: '{frames_match}'")

        if frames_match:
            if self.processed_stable_frame:
                return 0, 0, None
            if time.time() - self.frame_stabilization_timestamp < self.frame_stabilization:
                return 0, 0, None
            changed_lines = self._find_changed_lines_impl(current_result, self.stable_frame_data)
            if self.line_recovery and self.last_last_frame_data:
                logger.debug('Checking for missed lines')
                recovered_lines = self._find_changed_lines_impl(self.last_last_frame_data[1], self.stable_frame_data, current_result)
                recovered_lines_count = len(recovered_lines) if recovered_lines else 0
            else:
                recovered_lines_count = 0
                recovered_lines = []
            self.processed_stable_frame = True
            self.stable_frame_data = current_result
            changed_lines_count = len(changed_lines)
            if (changed_lines_count or recovered_lines_count) and not self.json_output:
                if recovered_lines:
                    changed_regions_image = self._create_changed_regions_image(pil_image, changed_lines, self.last_last_frame_data[0], recovered_lines)
                else:
                    changed_regions_image = self._create_changed_regions_image(pil_image, changed_lines, None, None)

                if not changed_regions_image:
                    logger.warning('Error occurred while creating the differential image')
                    return 0, 0, None
                return changed_lines_count, recovered_lines_count, changed_regions_image
            else:
                return changed_lines_count, recovered_lines_count, None
        else:
            self.last_last_frame_data = self.last_frame_data
            self.last_frame_data = (pil_image, current_result)
            self.processed_stable_frame = False
            self.frame_stabilization_timestamp = time.time()
            return 0, 0, None

    def _find_changed_lines_impl(self, current_result, previous_result, next_result=None):
        if not current_result:
            return None

        changed_lines = []
        current_lines = []
        previous_lines = []
        current_text = []
        previous_text = []

        for p in current_result.paragraphs:
            current_lines.extend(p.lines)
        if len(current_lines) == 0:
            return None

        for current_line in current_lines:
            current_text_line = self.get_line_text(current_line)
            current_text_line = self._normalize_line_for_comparison(current_text_line)
            current_text.append(current_text_line)
        if all(not current_text_line for current_text_line in current_lines):
            return None

        if previous_result:
            for p in previous_result.paragraphs:
                previous_lines.extend(p.lines)
            if next_result:
                for p in next_result.paragraphs:
                    previous_lines.extend(p.lines)

            for previous_line in previous_lines:
                previous_text_line = self.get_line_text(previous_line)
                previous_text_line = self._normalize_line_for_comparison(previous_text_line)
                previous_text.append(previous_text_line)

        all_previous_text = ''.join(previous_text)

        logger.debug("Previous text: '{}'", previous_text)

        for i, current_text_line in enumerate(current_text):
            if not current_text_line:
                continue

            if not next_result and len(current_text_line) < 3:
                text_similar = current_text_line in previous_text
            else:
                text_similar = current_text_line in all_previous_text

            logger.debug("Current line: '{}' Similar: '{}'", current_text_line, text_similar)

            if not text_similar:
                if next_result:
                    logger.opt(colors=True).debug("<red>Recovered line: '{}'</>", current_text_line)
                changed_lines.append(current_lines[i])

        return changed_lines

    def find_changed_lines_text(self, current_result, two_pass_processing_active, recovered_lines_count):
        frame_stabilization_active = self.frame_stabilization != 0

        if (not frame_stabilization_active) or two_pass_processing_active:
            changed_lines, changed_lines_count = self._find_changed_lines_text_impl(current_result, self.last_frame_text, None, None, recovered_lines_count, True)
            if changed_lines is None:
                return [], 0
            self.last_frame_text = current_result
            return changed_lines, changed_lines_count

        changed_lines_stabilization, changed_lines_stabilization_count = self._find_changed_lines_text_impl(current_result, self.last_frame_text, None, None, 0, False)
        if changed_lines_stabilization is None:
            return [], 0

        frames_match = changed_lines_stabilization_count == 0

        logger.debug(f"Frames match: '{frames_match}'")

        if frames_match:
            if self.processed_stable_frame:
                return [], 0
            if time.time() - self.frame_stabilization_timestamp < self.frame_stabilization:
                return [], 0
            if self.line_recovery and self.last_last_frame_text:
                logger.debug('Checking for missed lines')
                recovered_lines, recovered_lines_count = self._find_changed_lines_text_impl(self.last_last_frame_text, self.stable_frame_text, current_result, None, 0, False)
            else:
                recovered_lines_count = 0
                recovered_lines = []
            changed_lines, changed_lines_count = self._find_changed_lines_text_impl(current_result, self.stable_frame_text, None, recovered_lines, recovered_lines_count, True)
            self.processed_stable_frame = True
            self.stable_frame_text = current_result
            return changed_lines, changed_lines_count
        else:
            self.last_last_frame_text = self.last_frame_text
            self.last_frame_text = current_result
            self.processed_stable_frame = False
            self.frame_stabilization_timestamp = time.time()
            return [], 0

    def _find_changed_lines_text_impl(self, current_result, previous_result, next_result, recovered_lines, recovered_lines_count, regex_filter):
        if recovered_lines:
            current_result = recovered_lines + current_result

        if len(current_result) == 0:
            return None, 0

        changed_lines = []
        current_lines = []
        previous_text = []

        for current_line in current_result:
            current_text_line = self._normalize_line_for_comparison(current_line)
            current_lines.append(current_text_line)
        if all(not current_text_line for current_text_line in current_lines):
            return None, 0

        for prev_line in previous_result:
            prev_text = self._normalize_line_for_comparison(prev_line)
            previous_text.append(prev_text)
        if next_result is not None:
            for next_text in next_result:
                previous_text.extend(next_text)

        all_previous_text = ''.join(previous_text)

        logger.opt(colors=True).debug("<magenta>Previous text: '{}'</>", previous_text)

        first = True
        changed_lines_count = 0
        len_recovered_lines = 0 if not recovered_lines else len(recovered_lines)
        for i, current_text in enumerate(current_lines):
            changed_line = current_result[i]

            if changed_line == '\n':
                changed_lines.append(changed_line)
                continue
            if not current_text:
                continue

            if next_result is not None and len(current_text) < 3:
                text_similar = current_text in previous_text
            else:
                text_similar = current_text in all_previous_text

            logger.opt(colors=True).debug("<magenta>Current line: '{}' Similar: '{}'</>", changed_line, text_similar)

            if text_similar:
                continue

            if (recovered_lines is None or i - len_recovered_lines < 0) and recovered_lines_count > 0:
                if any(line.startswith(current_text) for j, line in enumerate(current_lines) if i != j):
                    logger.opt(colors=True).debug("<magenta>Skipping recovered line: '{}'</>", changed_line)
                    recovered_lines_count -= 1
                    continue

            if next_result is not None:
                logger.opt(colors=True).debug("<red>Recovered line: '{}'</>", changed_line)

            if first and len(current_text) > 3:
                first = False
                # For the first line, check if it contains the end of previous text
                if regex_filter and all_previous_text:
                    overlap = self._find_overlap(all_previous_text, current_text)
                    if overlap and len(current_text) > len(overlap):
                        logger.opt(colors=True).debug("<magenta>Found overlap: '{}'</>", overlap)
                        changed_line = self._cut_at_overlap(changed_line, overlap)
                        logger.opt(colors=True).debug("<magenta>After cutting: '{}'</>", changed_line)

            if regex_filter and self.manual_regex_filter:
                changed_line = self.manual_regex_filter.sub('', changed_line)
            changed_lines.append(changed_line)
            changed_lines_count += 1

        return changed_lines, changed_lines_count

    def _find_overlap(self, previous_text, current_text):
        min_overlap_length = 3
        max_overlap_length = min(len(previous_text), len(current_text))

        for overlap_length in range(max_overlap_length, min_overlap_length - 1, -1):
            previous_end = previous_text[-overlap_length:]
            current_start = current_text[:overlap_length]

            if previous_end == current_start:
                return previous_end

        return None

    def _cut_at_overlap(self, current_line, overlap):
        pattern_parts = []
        for char in overlap:
            if char in self.kana_variants:
                variants = self.kana_variants[char]
                pattern_parts.append(f'[{"".join(variants)}]')
            else:
                pattern_parts.append(re.escape(char))

        overlap_pattern = r'.*?'.join(pattern_parts)
        full_pattern = r'^.*?' + overlap_pattern

        logger.opt(colors=True).debug("<magenta>Cut regex: '{}'</>", full_pattern)

        match = re.search(full_pattern, current_line)
        if match:
            cut_position = match.end()
            return current_line[cut_position:]

        return current_line

    def order_paragraphs_and_lines(self, ocr_result):
        # Extract all lines and determine their orientation
        all_lines = []
        for paragraph in ocr_result.paragraphs:
            for line in paragraph.lines:
                if line.text is None:
                    line.text = self.get_line_text(line)

                if paragraph.writing_direction:
                    is_vertical = paragraph.writing_direction == 'TOP_TO_BOTTOM'
                else:
                    is_vertical = self._is_line_vertical(line, ocr_result.image_properties)

                all_lines.append({
                    'line_obj': line,
                    'is_vertical': is_vertical
                })

        if not all_lines:
            return ocr_result

        if self.debug_filtering:
            for p in ocr_result.paragraphs:
                logger.opt(colors=True).debug("<red>Engine paragraph: '{}' writing_direction: '{}'</>", [self.get_line_text(line) for line in p.lines], p.writing_direction)

        # Create new paragraphs
        new_paragraphs = self._create_paragraphs_from_lines(all_lines)

        # Merge very close paragraphs
        merged_paragraphs = self._merge_close_paragraphs(new_paragraphs)

        # Group paragraphs into rows
        rows = self._group_paragraphs_into_rows(merged_paragraphs)

        # Reorder paragraphs in each row
        reordered_rows = self._reorder_paragraphs_in_rows(rows)

        # Order rows from top to bottom and flatten
        final_paragraphs = self._flatten_rows_to_paragraphs(reordered_rows)

        return OcrResult(
            image_properties=ocr_result.image_properties,
            engine_capabilities=ocr_result.engine_capabilities,
            paragraphs=final_paragraphs
        )

    def _create_paragraphs_from_lines(self, lines):
        grouped = set()
        all_paragraphs = []

        def _group_lines(is_vertical):
            indices = [i for i, line in enumerate(lines) if (line['is_vertical'] in (is_vertical, None)) and i not in grouped]

            if len(indices) < 2:
                return

            if is_vertical:
                get_start = lambda l: l['line_obj'].bounding_box.top
                get_end = lambda l: l['line_obj'].bounding_box.bottom
            else:
                get_start = lambda l: l['line_obj'].bounding_box.left
                get_end = lambda l: l['line_obj'].bounding_box.right

            components = self._find_connected_components(
                items=[lines[i] for i in indices],
                should_connect=lambda l1, l2: self._should_group_in_same_paragraph(l1, l2, is_vertical),
                get_start_coord=get_start,
                get_end_coord=get_end
            )

            for component in components:
                if len(component) > 1:
                    original_indices = [indices[i] for i in component]
                    paragraph_lines = [lines[i] for i in original_indices]
                    new_paragraph = self._create_paragraph_from_lines(paragraph_lines, is_vertical, False)
                    all_paragraphs.append(new_paragraph)
                    grouped.update(original_indices)

        _group_lines(True)
        _group_lines(False)

        # Create paragraphs out of ungrouped lines
        ungrouped_lines = [line for i, line in enumerate(lines) if i not in grouped]
        for line in ungrouped_lines:
            new_paragraph = self._create_paragraph_from_lines([line], None, False)
            all_paragraphs.append(new_paragraph)

        return all_paragraphs

    def _create_paragraph_from_lines(self, lines, is_vertical, merging_step):
        if len(lines) > 1:
            if is_vertical:
                lines = sorted(lines, key=lambda x: x['line_obj'].bounding_box.right, reverse=True)
            else:
                lines = sorted(lines, key=lambda x: x['line_obj'].bounding_box.top)

            lines = self._merge_overlapping_lines(lines, is_vertical)

            if not merging_step and self.furigana_filter:
                lines = self._furigana_filter(lines, is_vertical)

            line_objs = [l['line_obj'] for l in lines]

            left = min(l.bounding_box.left for l in line_objs)
            right = max(l.bounding_box.right for l in line_objs)
            top = min(l.bounding_box.top for l in line_objs)
            bottom = max(l.bounding_box.bottom for l in line_objs)

            new_bbox = BoundingBox(
                center_x=(left + right) / 2,
                center_y=(top + bottom) / 2,
                width=right - left,
                height=bottom - top
            )

            writing_direction = 'TOP_TO_BOTTOM' if is_vertical else 'LEFT_TO_RIGHT'
        else:
            line_objs = [lines[0]['line_obj']]
            new_bbox = lines[0]['line_obj'].bounding_box
            writing_direction = 'TOP_TO_BOTTOM' if lines[0]['is_vertical'] else 'LEFT_TO_RIGHT'

        paragraph = Paragraph(
            bounding_box=new_bbox,
            lines=line_objs,
            writing_direction=writing_direction
        )

        if not merging_step:
            character_size = self._calculate_character_size(lines, is_vertical)

            return {
                'paragraph_obj': paragraph,
                'character_size': character_size
            }

        return paragraph

    def _calculate_character_size(self, lines, is_vertical):
        if is_vertical:
            largest_line = max(lines, key=lambda x: x['line_obj'].bounding_box.width)
            line_dimension = largest_line['line_obj'].bounding_box.height
        else:
            largest_line = max(lines, key=lambda x: x['line_obj'].bounding_box.height)
            line_dimension = largest_line['line_obj'].bounding_box.width

        char_count = len(self.get_line_text(largest_line['line_obj']))

        if char_count == 0:
            return 0.0

        return line_dimension / char_count

    def _should_group_in_same_paragraph(self, line1, line2, is_vertical):
        bbox1 = line1['line_obj'].bounding_box
        bbox2 = line2['line_obj'].bounding_box

        if is_vertical:
            vertical_overlap = self._check_vertical_overlap(bbox1, bbox2)
            horizontal_distance = self._calculate_horizontal_distance(bbox1, bbox2)
            line_width = max(bbox1.width, bbox2.width)

            return vertical_overlap > 0.1 and horizontal_distance < line_width * 2
        else:
            horizontal_overlap = self._check_horizontal_overlap(bbox1, bbox2)
            vertical_distance = self._calculate_vertical_distance(bbox1, bbox2)
            line_height = max(bbox1.height, bbox2.height)

            return horizontal_overlap > 0.1 and vertical_distance < line_height * 2

    def _merge_overlapping_lines(self, lines, is_vertical):
        if len(lines) < 2:
            return lines

        merged = []
        used_indices = set()

        for i, current_line in enumerate(lines):
            if i in used_indices:
                continue

            # Start with the current line
            merge_group = [current_line]
            used_indices.add(i)
            last_line_in_group = current_line

            # Check subsequent lines in order
            for j, candidate_line in enumerate(lines[i+1:], i+1):
                if j in used_indices:
                    continue

                # Only check if candidate should merge with the last line in our current group
                if self._should_merge_lines(last_line_in_group, candidate_line, is_vertical):
                    merge_group.append(candidate_line)
                    used_indices.add(j)
                    last_line_in_group = candidate_line  # Update last line for next comparison

            # Merge all lines in the group into one
            if len(merge_group) > 1:
                merged_line = self._merge_multiple_lines(merge_group, is_vertical)
                merged.append(merged_line)
                if self.debug_filtering:
                    logger.opt(colors=True).debug("<green>Merged lines: '{}' vertical: '{}'</>", [self.get_line_text(line['line_obj']) for line in merge_group], is_vertical)
            else:
                merged.append(current_line)

        return merged

    def _merge_multiple_lines(self, lines, is_vertical):
        if is_vertical:
            # Sort lines by y-coordinate (top to bottom)
            sort_key = lambda line: line['line_obj'].bounding_box.center_y
        else:
            # Sort lines by x-coordinate (left to right)
            sort_key = lambda line: line['line_obj'].bounding_box.center_x

        lines = sorted(lines, key=sort_key)

        text_sorted = ''
        for line in lines:
            text_sorted += line['line_obj'].text

        words_sorted = []
        for line in lines:
            words_sorted.extend(line['line_obj'].words)

        # Calculate new bounding box that encompasses all lines
        bboxes = [line['line_obj'].bounding_box for line in lines]

        left = min(bbox.left for bbox in bboxes)
        right = max(bbox.right for bbox in bboxes)
        top = min(bbox.top for bbox in bboxes)
        bottom = max(bbox.bottom for bbox in bboxes)

        new_bbox = BoundingBox(
            center_x=(left + right) / 2,
            center_y=(top + bottom) / 2,
            width=right - left,
            height=bottom - top
        )

        # Create new merged line
        merged_line = Line(
            bounding_box=new_bbox,
            words=words_sorted,
            text=text_sorted
        )

        return {
            'line_obj': merged_line,
            'is_vertical': is_vertical
        }

    def _should_merge_lines(self, line1, line2, is_vertical):
        bbox1 = line1['line_obj'].bounding_box
        bbox2 = line2['line_obj'].bounding_box

        if is_vertical:
            horizontal_overlap = self._check_horizontal_overlap(bbox1, bbox2)
            vertical_overlap = self._check_vertical_overlap(bbox1, bbox2)

            return horizontal_overlap > 0.7 and vertical_overlap < 0.4

        else:
            vertical_overlap = self._check_vertical_overlap(bbox1, bbox2)
            horizontal_overlap = self._check_horizontal_overlap(bbox1, bbox2)

            return vertical_overlap > 0.7 and horizontal_overlap < 0.4

    def _furigana_filter(self, lines, is_vertical):
        filtered_lines = []

        for line in lines:
            line_text = self.get_line_text(line['line_obj'])
            normalized_line_text = ''.join(self.cj_regex.findall(line_text))
            line['normalized_text'] = normalized_line_text
        if all(not line['normalized_text'] for line in lines):
            return lines

        for i, line in enumerate(lines):
            if i >= len(lines) - 1:
                filtered_lines.append(line)
                continue

            current_line_text = self.get_line_text(line['line_obj'])
            current_line_bbox = line['line_obj'].bounding_box
            next_line = lines[i + 1]
            next_line_text = self.get_line_text(next_line['line_obj'])
            next_line_bbox = next_line['line_obj'].bounding_box

            if not (line['normalized_text'] and next_line['normalized_text']):
                filtered_lines.append(line)
                continue
            has_kanji = self.kanji_regex.search(line['normalized_text'])
            if has_kanji:
                filtered_lines.append(line)
                continue
            next_has_kanji = self.kanji_regex.search(next_line['normalized_text'])
            if not next_has_kanji:
                filtered_lines.append(line)
                continue

            logger.opt(colors=True).debug("<magenta>Furigana check line: '{}' against line: '{}' vertical: '{}'</>", current_line_text, next_line_text, is_vertical)

            if is_vertical:
                min_h_distance = abs(next_line_bbox.width - current_line_bbox.width) / 2
                max_h_distance = next_line_bbox.width + (current_line_bbox.width / 2)
                min_v_overlap = 0.4

                horizontal_distance = current_line_bbox.center_x - next_line_bbox.center_x
                vertical_overlap = self._check_vertical_overlap(current_line_bbox, next_line_bbox)

                logger.opt(colors=True).debug(f"<magenta>Vertical position: min h.dist '{min_h_distance:.4f}' max h.dist '{max_h_distance:.4f}' h.dist '{horizontal_distance:.4f}' v.overlap '{vertical_overlap:.4f}'</>")

                passed_position_check = min_h_distance < horizontal_distance < max_h_distance and vertical_overlap > min_v_overlap
            else:
                min_v_distance = abs(next_line_bbox.height - current_line_bbox.height) / 2
                max_v_distance = next_line_bbox.height + (current_line_bbox.height / 2)
                min_h_overlap = 0.4

                vertical_distance = next_line_bbox.center_y - current_line_bbox.center_y
                horizontal_overlap = self._check_horizontal_overlap(current_line_bbox, next_line_bbox)

                logger.opt(colors=True).debug(f"<magenta>Horizontal position: min v.dist '{min_v_distance:.4f}' max v.dist '{max_v_distance:.4f}' v.dist '{vertical_distance:.4f}' h.overlap '{horizontal_overlap:.4f}'</>")

                passed_position_check = min_v_distance < vertical_distance < max_v_distance and horizontal_overlap > min_h_overlap

            if not passed_position_check:
                filtered_lines.append(line)
                continue

            if is_vertical:
                width_threshold = next_line_bbox.width * 0.77
                passed_size_check = current_line_bbox.width < width_threshold
                logger.opt(colors=True).debug(f"<magenta>Vertical size (width): kanji '{next_line_bbox.width:.4f}' kana '{current_line_bbox.width:.4f}' max kana '{width_threshold:.4f}'</>")
            else:
                height_threshold = next_line_bbox.height * 0.85
                passed_size_check = current_line_bbox.height < height_threshold
                logger.opt(colors=True).debug(f"<magenta>Horizontal size (height): kanji '{next_line_bbox.height:.4f}' kana '{current_line_bbox.height:.4f}' max kana '{height_threshold:.4f}'</>")

            if not passed_size_check:
                filtered_lines.append(line)
                continue

            logger.opt(colors=True).debug("<yellow>Skipping furigana line: '{}' next to line: '{}'</>", current_line_text, next_line_text)

        return filtered_lines

    def _merge_close_paragraphs(self, paragraphs):
        if len(paragraphs) < 2:
            return [p['paragraph_obj'] for p in paragraphs]

        merged_paragraphs = []

        def _merge_paragraphs(is_vertical):
            indices = [i for i, paragraph in enumerate(paragraphs) if ((paragraph['paragraph_obj'].writing_direction == 'TOP_TO_BOTTOM') == is_vertical)]

            if len(indices) == 0:
                return
            if len(indices) == 1:
                merged_paragraphs.append(paragraphs[indices[0]]['paragraph_obj'])
                return

            if is_vertical:
                get_start = lambda p: p['paragraph_obj'].bounding_box.left
                get_end = lambda p: p['paragraph_obj'].bounding_box.right
            else:
                get_start = lambda p: p['paragraph_obj'].bounding_box.top
                get_end = lambda p: p['paragraph_obj'].bounding_box.bottom

            components = self._find_connected_components(
                items=[paragraphs[i] for i in indices],
                should_connect=lambda p1, p2: self._should_merge_close_paragraphs(p1, p2, is_vertical),
                get_start_coord=get_start,
                get_end_coord=get_end
            )

            for component in components:
                original_indices = [indices[i] for i in component]
                if len(component) == 1:
                    merged_paragraphs.append(paragraphs[original_indices[0]]['paragraph_obj'])
                else:
                    component_paragraphs = [paragraphs[i] for i in original_indices]
                    if self.debug_filtering:
                        logger.opt(colors=True).debug("<green>Merged paragraphs vertical: '{}'</>", is_vertical)
                        for p in component_paragraphs:
                            logger.opt(colors=True).debug("<green>    Paragraph: '{}'</>", [self.get_line_text(line) for line in p['paragraph_obj'].lines])
                    merged_paragraph = self._merge_multiple_paragraphs(component_paragraphs, is_vertical)
                    merged_paragraphs.append(merged_paragraph)

        _merge_paragraphs(True)
        _merge_paragraphs(False)

        return merged_paragraphs

    def _should_merge_close_paragraphs(self, paragraph1, paragraph2, is_vertical):
        bbox1 = paragraph1['paragraph_obj'].bounding_box
        bbox2 = paragraph2['paragraph_obj'].bounding_box

        character_size = max(paragraph1['character_size'], paragraph2['character_size'])

        if is_vertical:
            vertical_distance = self._calculate_vertical_distance(bbox1, bbox2)
            horizontal_overlap = self._check_horizontal_overlap(bbox1, bbox2)

            return vertical_distance <= 3 * character_size and horizontal_overlap > 0.4
        else:
            horizontal_distance = self._calculate_horizontal_distance(bbox1, bbox2)
            vertical_overlap = self._check_vertical_overlap(bbox1, bbox2)

            return horizontal_distance <= 3 * character_size and vertical_overlap > 0.4

    def _merge_multiple_paragraphs(self, paragraphs, is_vertical):
        merged_lines = []
        for p in paragraphs:
            for line in p['paragraph_obj'].lines:
                merged_lines.append({
                    'line_obj': line,
                    'is_vertical': is_vertical
                })

        return self._create_paragraph_from_lines(merged_lines, is_vertical, True)

    def _group_paragraphs_into_rows(self, paragraphs):
        if len(paragraphs) < 2:
            return [{'paragraphs': paragraphs, 'is_vertical': False}]

        components = self._find_connected_components(
            items=paragraphs,
            should_connect=lambda p1, p2: self._check_vertical_overlap(p1.bounding_box, p2.bounding_box) > 0.4,
            get_start_coord=lambda p: p.bounding_box.top,
            get_end_coord=lambda p: p.bounding_box.bottom
        )

        rows = []
        for component in components:
            row_paragraphs = [paragraphs[i] for i in component]
            vertical_count = sum(1 for p in row_paragraphs if p.writing_direction == 'TOP_TO_BOTTOM')
            is_vertical = vertical_count * 2 >= len(row_paragraphs)

            rows.append({
                'paragraphs': row_paragraphs,
                'is_vertical': is_vertical
            })

        return rows

    def _reorder_paragraphs_in_rows(self, rows):
        reordered_rows = []

        for row in rows:
            paragraphs = row['paragraphs']
            is_vertical = row['is_vertical']

            if len(paragraphs) < 2:
                reordered_rows.append(row)
                continue

            # Sort paragraphs by x-coordinate (left edge)
            paragraphs_sorted = sorted(paragraphs, key=lambda p: p.bounding_box.left)

            if is_vertical:
                # Reverse the entire order for predominantly vertical rows
                paragraphs_sorted.reverse()

            # Further reorder contiguous blocks with different orientation
            final_order = self._reorder_mixed_orientation_blocks(paragraphs_sorted, is_vertical)

            reordered_rows.append({
                'paragraphs': final_order,
                'is_vertical': is_vertical
            })

        return reordered_rows

    def _reorder_mixed_orientation_blocks(self, paragraphs, row_is_vertical):
        if len(paragraphs) < 2:
            return paragraphs

        result = []
        current_block = [paragraphs[0]]
        current_orientation = paragraphs[0].writing_direction == 'TOP_TO_BOTTOM'

        for para in paragraphs[1:]:
            para_orientation = para.writing_direction == 'TOP_TO_BOTTOM'

            if para_orientation == current_orientation:
                current_block.append(para)
            else:
                # Process the completed block
                if current_orientation != row_is_vertical:
                    # Reverse blocks that don't match row orientation
                    current_block.reverse()
                result.extend(current_block)

                # Start new block
                current_block = [para]
                current_orientation = para_orientation

        # Process the last block
        if current_orientation != row_is_vertical:
            current_block.reverse()
        result.extend(current_block)

        return result

    def _flatten_rows_to_paragraphs(self, rows):
        rows_sorted = sorted(rows, key=lambda r: min(p.bounding_box.top for p in r['paragraphs']))

        if self.debug_filtering:
            for r in rows_sorted:
                logger.opt(colors=True).debug("<green>Row vertical: '{}'</>", r['is_vertical'])
                for p in r['paragraphs']:
                    logger.opt(colors=True).debug("<green>    Paragraph: '{}' vertical: '{}'</>", [self.get_line_text(line) for line in p.lines], p.writing_direction == 'TOP_TO_BOTTOM')

        all_paragraphs = []
        for row in rows_sorted:
            all_paragraphs.extend(row['paragraphs'])

        return all_paragraphs

    def _calculate_horizontal_distance(self, bbox1, bbox2):
        if bbox1.right < bbox2.left:
            return bbox2.left - bbox1.right
        elif bbox2.right < bbox1.left:
            return bbox1.left - bbox2.right
        else:
            return 0.0

    def _calculate_vertical_distance(self, bbox1, bbox2):
        if bbox1.bottom < bbox2.top:
            return bbox2.top - bbox1.bottom
        elif bbox2.bottom < bbox1.top:
            return bbox1.top - bbox2.bottom
        else:
            return 0.0

    def _is_line_vertical(self, line, image_properties):
        # For very short lines (less than 3 characters), undefined orientation
        if len(self.get_line_text(line)) < 3:
            return None

        bbox = line.bounding_box
        pixel_width = bbox.width * image_properties.width
        pixel_height = bbox.height * image_properties.height

        aspect_ratio = pixel_width / pixel_height
        return aspect_ratio < 0.8

    def _check_horizontal_overlap(self, bbox1, bbox2):
        left1 = bbox1.left
        right1 = bbox1.right
        left2 = bbox2.left
        right2 = bbox2.right

        overlap_left = max(left1, left2)
        overlap_right = min(right1, right2)

        if overlap_right <= overlap_left:
            return 0.0

        overlap_width = overlap_right - overlap_left
        smaller_width = min(bbox1.width, bbox2.width)

        return overlap_width / smaller_width if smaller_width > 0 else 0.0

    def _check_vertical_overlap(self, bbox1, bbox2):
        top1 = bbox1.top
        bottom1 = bbox1.bottom
        top2 = bbox2.top
        bottom2 = bbox2.bottom

        overlap_top = max(top1, top2)
        overlap_bottom = min(bottom1, bottom2)

        if overlap_bottom <= overlap_top:
            return 0.0

        overlap_height = overlap_bottom - overlap_top
        smaller_height = min(bbox1.height, bbox2.height)

        return overlap_height / smaller_height if smaller_height > 0 else 0.0

    def _find_connected_components(self, items, should_connect, get_start_coord, get_end_coord):
        # Build graph using sweep-line algorithm
        graph = {i: [] for i in range(len(items))}

        # Sort items by appropriate coordinate for sweep-line
        sorted_items = sorted(
            [(i, items[i]) for i in range(len(items))],
            key=lambda x: get_start_coord(x[1])
        )

        active_items = []  # (index, item, end_coordinate)

        for original_idx, item in sorted_items:
            current_start = get_start_coord(item)
            line_end = get_end_coord(item)

            # Remove items that are no longer overlapping
            active_items = [
                (active_idx, active_item, active_end)
                for active_idx, active_item, active_end in active_items
                if active_end > current_start  # Still overlapping
            ]

            # Check current item against all active items
            for active_idx, active_item, _ in active_items:
                if should_connect(item, active_item):
                    graph[original_idx].append(active_idx)
                    graph[active_idx].append(original_idx)

            # Add current item to active list
            active_items.append((original_idx, item, line_end))

        # Find connected components using BFS
        visited = set()
        connected_components = []

        for i in range(len(items)):
            if i not in visited:
                component = []
                queue = collections.deque([i])
                visited.add(i)
                while queue:
                    node = queue.popleft()
                    component.append(node)
                    for neighbor in graph[node]:
                        if neighbor not in visited:
                            visited.add(neighbor)
                            queue.append(neighbor)
                connected_components.append(component)

        return connected_components

    def _create_changed_regions_image(self, pil_image, changed_lines, pil_image_2, changed_lines_2, margin=5):
        def crop_image(image, lines):
            img_width, img_height = image.size

            regions = []
            for line in lines:
                bbox = line.bounding_box
                x1 = (bbox.center_x - bbox.width/2) * img_width - margin
                y1 = (bbox.center_y - bbox.height/2) * img_height - margin
                x2 = (bbox.center_x + bbox.width/2) * img_width + margin
                y2 = (bbox.center_y + bbox.height/2) * img_height + margin

                x1 = max(0, int(x1))
                y1 = max(0, int(y1))
                x2 = min(img_width, int(x2))
                y2 = min(img_height, int(y2))

                if x2 > x1 and y2 > y1:
                    regions.append((x1, y1, x2, y2))

            if not regions:
                return None

            overall_x1 = min(x1 for x1, y1, x2, y2 in regions)
            overall_y1 = min(y1 for x1, y1, x2, y2 in regions)
            overall_x2 = max(x2 for x1, y1, x2, y2 in regions)
            overall_y2 = max(y2 for x1, y1, x2, y2 in regions)

            return image.crop((overall_x1, overall_y1, overall_x2, overall_y2))

        # Handle the case where changed_lines is empty and previous_result is provided
        if (not pil_image) and pil_image_2:
            cropped_2 = crop_image(pil_image_2, changed_lines_2)
            return cropped_2

        # Handle the case where both current and previous results are present
        elif pil_image and pil_image_2:
            # Crop both images
            cropped_1 = crop_image(pil_image, changed_lines)
            cropped_2 = crop_image(pil_image_2, changed_lines_2)

            if cropped_1 is None and cropped_2 is None:
                return None
            elif cropped_1 is None:
                return cropped_2
            elif cropped_2 is None:
                return cropped_1

            # Stitch vertically with previous_result on top
            total_width = max(cropped_1.width, cropped_2.width)
            total_height = cropped_1.height + cropped_2.height

            # Create a new image with white background
            stitched_image = Image.new('RGB', (total_width, total_height), 'white')

            # Paste previous (top) and current (bottom) images, centered horizontally
            prev_x_offset = (total_width - cropped_2.width) // 2
            stitched_image.paste(cropped_2, (prev_x_offset, 0))

            curr_x_offset = (total_width - cropped_1.width) // 2
            stitched_image.paste(cropped_1, (curr_x_offset, cropped_2.height))

            return stitched_image
        elif pil_image:
            return crop_image(pil_image, changed_lines)
        else:
            return None


class ScreenshotThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        screen_capture_area = config.get_general('screen_capture_area')
        self.coordinate_selector_combo_enabled = config.get_general('coordinate_selector_combo') != ''
        self.macos_window_tracker_instance = None
        self.windows_window_tracker_instance = None
        self.window_handle = None
        self.window_active = True
        self.window_visible = True
        self.window_closed = False
        self.window_size = None
        self.current_coordinates = None
        self.area_mask = None

        try:
            self.sct = mss.mss()
        except mss.exception.ScreenShotError as e:
            exit_with_error(f'Error initializing screenshots: {e}')

        if screen_capture_area == '':
            self.screencapture_mode = 0
        elif screen_capture_area.startswith('screen_'):
            parts = screen_capture_area.split('_')
            if len(parts) != 2 or not parts[1].isdigit():
                exit_with_error('Invalid screen_capture_area')
            screen_capture_monitor = int(parts[1])
            self.screencapture_mode = 1
        elif len(screen_capture_area.replace('_', ',').split(',')) % 4 == 0:
            self.screencapture_mode = 3
        else:
            if sys.platform == 'linux' and os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland':
                self.screencapture_mode = 0
            else:
                self.screencapture_mode = 2

        if self.coordinate_selector_combo_enabled:
            self.launch_coordinate_picker(True, False)

        if self.screencapture_mode != 2:
            if self.screencapture_mode == 0:
                self.launch_coordinate_picker(False, True)
            elif self.screencapture_mode == 1:
                mon = self.sct.monitors
                if len(mon) <= screen_capture_monitor:
                    exit_with_error('Invalid monitor number in screen_capture_area')
                coord_left = mon[screen_capture_monitor]['left']
                coord_top = mon[screen_capture_monitor]['top']
                coord_width = mon[screen_capture_monitor]['width']
                coord_height = mon[screen_capture_monitor]['height']
                self.sct_params = {'left': coord_left, 'top': coord_top, 'width': coord_width, 'height': coord_height}
                logger.info(f'Selected whole screen')
            elif self.screencapture_mode == 3:
                saved_rectangles = self.parse_saved_coordinates(screen_capture_area, False)
                if len(saved_rectangles) == 0:
                    exit_with_error('Invalid coordinate set(s) in screen_capture_area')
                elif len(saved_rectangles) == 1:
                    x1, y1, x2, y2 = saved_rectangles[0]['coordinates']
                    display_rectangles = f'{x1},{y1},{x2},{y2}'
                else:
                    x1, y1, x2, y2 = self.find_minimum_rectangle(saved_rectangles)
                    self.area_mask = self.generate_mask((x1, y1, x2, y2), saved_rectangles)
                    display_rectangles = '_'.join([','.join(map(str, r['coordinates'])) for r in saved_rectangles])

                logger.info(f'Selected coordinates: {display_rectangles}')
                self.current_coordinates = saved_rectangles
                self.sct_params = {'left': x1, 'top': y1, 'width': x2 - x1, 'height': y2 - y1}
        else:
            self.screen_capture_only_active_windows = config.get_general('screen_capture_only_active_windows')
            self.window_area_coordinates = None

            if sys.platform == 'darwin':
                if config.get_general('screen_capture_old_macos_api') or int(platform.mac_ver()[0].split('.')[0]) < 14:
                    self.old_macos_screenshot_api = True
                else:
                    self.old_macos_screenshot_api = False
                    self.window_stream_configuration = None
                    self.window_content_filter = None
                    self.screencapturekit_queue = queue.Queue()
                    CGMainDisplayID()
                window_list = CGWindowListCopyWindowInfo(kCGWindowListExcludeDesktopElements, kCGNullWindowID)
                window_titles = []
                window_handles = []
                window_index = None
                for i, window in enumerate(window_list):
                    window_title = window.get(kCGWindowName, '')
                    if psutil.Process(window['kCGWindowOwnerPID']).name() not in ('Terminal', 'iTerm2'):
                        window_titles.append(window_title)
                        window_handles.append(window['kCGWindowNumber'])

                if screen_capture_area in window_titles:
                    window_index = window_titles.index(screen_capture_area)
                else:
                    for t in window_titles:
                        if screen_capture_area in t:
                            window_index = window_titles.index(t)
                            break

                if not window_index:
                    exit_with_error('"screen_capture_area" must be empty, "screen_N" where N is a screen number starting from 1, one or more sets of rectangle coordinates, or a window name')

                self.window_handle = window_handles[window_index]
                window_title = window_titles[window_index]

                if self.screen_capture_only_active_windows:
                    self.macos_window_tracker_instance = threading.Thread(target=self.macos_window_tracker)
                    self.macos_window_tracker_instance.start()
                logger.info(f'Selected window: {window_title}')
            elif sys.platform == 'win32':
                self.window_handle, window_title = self.get_windows_window_handle(screen_capture_area)

                if not self.window_handle:
                    exit_with_error('"screen_capture_area" must be empty, "screen_N" where N is a screen number starting from 1, one or more sets of rectangle coordinates, or a window name')

                ctypes.windll.shcore.SetProcessDpiAwareness(2)
                self.window_visible = not win32gui.IsIconic(self.window_handle)
                self.windows_window_mfc_dc = None
                self.windows_window_save_dc = None
                self.windows_window_save_bitmap = None

                self.windows_window_tracker_instance = threading.Thread(target=self.windows_window_tracker)
                self.windows_window_tracker_instance.start()
                logger.info(f'Selected window: {window_title}')
            else:
                exit_with_error('Window capture is only currently supported on Windows, macOS and Linux + Wayland')

            screen_capture_window_area = config.get_general('screen_capture_window_area')
            if screen_capture_window_area != 'window':
                if screen_capture_window_area == '':
                    self.launch_coordinate_picker(False, False)
                elif len(screen_capture_window_area.replace('_', ',').split(',')) % 4 == 0:
                    saved_rectangles = self.parse_saved_coordinates(screen_capture_window_area, True)
                    if len(saved_rectangles) == 0:
                        exit_with_error('Invalid coordinate set(s) in screen_capture_window_area')
                    elif len(saved_rectangles) == 1:
                        x1, y1, x2, y2 = saved_rectangles[0]['coordinates']
                        display_rectangles = f'{x1},{y1},{x2},{y2}'
                    else:
                        x1, y1, x2, y2 = self.find_minimum_rectangle(saved_rectangles)
                        self.area_mask = self.generate_mask((x1, y1, x2, y2), saved_rectangles)
                        display_rectangles = '_'.join([','.join(map(str, r['coordinates'])) for r in saved_rectangles])

                    logger.info(f'Selected window coordinates: {display_rectangles}')
                    self.current_coordinates = saved_rectangles
                    self.window_area_coordinates = (x1, y1, x2, y2)
                else:
                    exit_with_error('"screen_capture_window_area" must be empty, "window" for the whole window, one or more sets of rectangle coordinates')

    def parse_saved_coordinates(self, saved_coordinates, is_window):
        result = []
        coordinate_sets = saved_coordinates.split('_')

        if not is_window:
            monitors = self.sct.monitors[1:]
        else:
            img, _ = self.take_screenshot(True)

        for coord_set in coordinate_sets:
            numbers = coord_set.split(',')

            coord_tuple = tuple(int(num) for num in numbers)
            found_monitor = None

            if not is_window:
                for monitor in monitors:
                    x1_monitor = monitor['left']
                    y1_monitor = monitor['top']
                    x2_monitor = monitor['left'] + monitor['width']
                    y2_monitor = monitor['top'] + monitor['height']
                    if (x1_monitor <= coord_tuple[0] <= x2_monitor and y1_monitor <= coord_tuple[1] <= y2_monitor
                    and x1_monitor <= coord_tuple[2] <= x2_monitor and y1_monitor <= coord_tuple[3] <= y2_monitor):
                        found_monitor = monitor
                        break
                if not found_monitor:
                    continue
            else:
                valid_coordinates = False
                x1_window = 0
                y1_window = 0
                x2_window = 0 + img.width
                y2_window = 0 + img.height
                if (x1_window <= coord_tuple[0] <= x2_window and y1_window <= coord_tuple[1] <= y2_window
                and x1_window <= coord_tuple[2] <= x2_window and y1_window <= coord_tuple[3] <= y2_window):
                    valid_coordinates = True
                if not valid_coordinates:
                    continue

            result.append({
                'coordinates': coord_tuple,
                'monitor': found_monitor
            })

        return result

    def find_minimum_rectangle(self, coordinates):
        min_x = min(r['coordinates'][0] for r in coordinates)
        min_y = min(r['coordinates'][1] for r in coordinates)
        max_x = max(r['coordinates'][2] for r in coordinates)
        max_y = max(r['coordinates'][3] for r in coordinates)

        return min_x, min_y, max_x, max_y

    def generate_mask(self, outer_rectangle, coordinates):
        x1_outer, y1_outer, x2_outer, y2_outer = outer_rectangle

        mask = Image.new('L', (x2_outer - x1_outer, y2_outer - y1_outer), 0)
        draw = ImageDraw.Draw(mask)

        for r in coordinates:
            x1, y1, x2, y2 = r['coordinates']
            adj_rect = (x1 - x1_outer, y1 - y1_outer, x2 - x1_outer, y2 - y1_outer)
            draw.rectangle(adj_rect, fill=255)

        return mask

    def get_windows_window_handle(self, window_title):
        def callback(hwnd, window_title_part):
            window_title = win32gui.GetWindowText(hwnd)
            if window_title_part in window_title:
                handles.append((hwnd, window_title))
            return True

        handle = win32gui.FindWindow(None, window_title)
        if handle:
            return (handle, window_title)

        handles = []
        win32gui.EnumWindows(callback, window_title)
        for handle in handles:
            _, pid = win32process.GetWindowThreadProcessId(handle[0])
            if psutil.Process(pid).name().lower() not in ('cmd.exe', 'powershell.exe', 'windowsterminal.exe'):
                return handle

        return (None, None)

    def windows_window_tracker(self):
        found = True
        while not terminated.is_set():
            found = win32gui.IsWindow(self.window_handle)
            if not found:
                break
            if self.screen_capture_only_active_windows:
                self.window_active = self.window_handle == win32gui.GetForegroundWindow()
            self.window_visible = not win32gui.IsIconic(self.window_handle)
            time.sleep(0.5)
        if not found:
            self.window_closed = True

    def capture_macos_window_screenshot(self):
        def shareable_content_completion_handler(shareable_content, error):
            if error:
                self.screencapturekit_queue.put(None)
                return

            target_window = None
            for window in shareable_content.windows():
                if window.windowID() == self.window_handle:
                    target_window = window
                    break

            self.screencapturekit_queue.put(target_window)

        def capture_image_completion_handler(image, error):
            if error:
                self.screencapturekit_queue.put(None)
                return

            with objc.autorelease_pool():
                try:
                    width = CGImageGetWidth(image)
                    height = CGImageGetHeight(image)
                    raw_data = CGDataProviderCopyData(CGImageGetDataProvider(image))
                    assert raw_data is not None
                    bpr = CGImageGetBytesPerRow(image)
                    img = Image.frombuffer('RGBA', (width, height), raw_data, 'raw', 'BGRA', bpr, 1)
                    self.screencapturekit_queue.put(img)
                except:
                    self.screencapturekit_queue.put(None)

        window_list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, self.window_handle)
        if not window_list or len(window_list) == 0:
            return None, None
        window_info = window_list[0]
        bounds = window_info.get('kCGWindowBounds')
        if not bounds:
            return None, None

        width = bounds['Width']
        height = bounds['Height']
        x = bounds['X']
        y = bounds['Y']
        current_size = (width, height)

        if self.window_size != current_size:
            SCShareableContent.getShareableContentWithCompletionHandler_(
                shareable_content_completion_handler
            )

            try:
                result = self.screencapturekit_queue.get(timeout=0.5)
            except queue.Empty:
                return None, None
            if not result:
                return None, None

            if self.window_content_filter:
                self.window_content_filter.dealloc()
            self.window_content_filter = SCContentFilter.alloc().initWithDesktopIndependentWindow_(result)

        if not self.window_stream_configuration:
            self.window_stream_configuration = SCStreamConfiguration.alloc().init()
            self.window_stream_configuration.setShowsCursor_(False)
            self.window_stream_configuration.setCaptureResolution_(SCCaptureResolutionNominal)
            self.window_stream_configuration.setIgnoreGlobalClipSingleWindow_(True)

        if self.window_size != current_size:
            self.window_stream_configuration.setSourceRect_(CGRectMake(0, 0, width, height))
            self.window_stream_configuration.setWidth_(width)
            self.window_stream_configuration.setHeight_(height)

        SCScreenshotManager.captureImageWithFilter_configuration_completionHandler_(
            self.window_content_filter, self.window_stream_configuration, capture_image_completion_handler
        )

        try:
            return self.screencapturekit_queue.get(timeout=5), (x, y)
        except queue.Empty:
            return None, None

    def macos_window_tracker(self):
        found = True
        while found and not terminated.is_set():
            found = False
            is_active = False
            with objc.autorelease_pool():
                window_list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
                for i, window in enumerate(window_list):
                    if found and window.get(kCGWindowName, '') == 'Fullscreen Backdrop':
                        is_active = True
                        break
                    if self.window_handle == window['kCGWindowNumber']:
                        found = True
                        if i == 0 or window_list[i-1].get(kCGWindowName, '') in ('Dock', 'Color Enforcer Window'):
                            is_active = True
                            break
                if not found:
                    window_list = CGWindowListCreateDescriptionFromArray([self.window_handle])
                    if len(window_list) > 0:
                        found = True
            if found:
                self.window_active = is_active
            time.sleep(0.5)
        if not found:
            self.window_closed = True

    def take_screenshot(self, ignore_active_status):
        x = None
        y = None
        window_x = None
        window_y = None
        if self.screencapture_mode == 2:
            if self.window_closed:
                return False, None
            if not ignore_active_status and not self.window_active:
                return None, None
            if not self.window_visible:
                return None, None
            if sys.platform == 'darwin':
                with objc.autorelease_pool():
                    if self.old_macos_screenshot_api:
                        try:
                            cg_image = CGWindowListCreateImageFromArray(CGRectNull, [self.window_handle], kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution)
                            width = CGImageGetWidth(cg_image)
                            height = CGImageGetHeight(cg_image)
                            raw_data = CGDataProviderCopyData(CGImageGetDataProvider(cg_image))
                            assert raw_data is not None
                            bpr = CGImageGetBytesPerRow(cg_image)
                            img = Image.frombuffer('RGBA', (width, height), raw_data, 'raw', 'BGRA', bpr, 1)
                            window_list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, self.window_handle)
                            if window_list:
                                bounds = window_list[0].get('kCGWindowBounds')
                                if bounds:
                                    x = bounds['X']
                                    y = bounds['Y']
                        except:
                            img = None
                    else:
                        img, image_offset = self.capture_macos_window_screenshot()
                        if image_offset:
                            x, y = image_offset
                if not img:
                    return False, None
            else:
                try:
                    coord_left, coord_top, right, bottom = win32gui.GetWindowRect(self.window_handle)
                    coord_width = right - coord_left
                    coord_height = bottom - coord_top

                    current_size = (coord_width, coord_height)
                    if self.window_size != current_size:
                        self.cleanup_window_screen_capture()
                        hwnd_dc = win32gui.GetWindowDC(self.window_handle)
                        self.windows_window_mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
                        self.windows_window_save_dc = self.windows_window_mfc_dc.CreateCompatibleDC()
                        self.windows_window_save_bitmap = win32ui.CreateBitmap()
                        self.windows_window_save_bitmap.CreateCompatibleBitmap(self.windows_window_mfc_dc, coord_width, coord_height)
                        self.windows_window_save_dc.SelectObject(self.windows_window_save_bitmap)
                        win32gui.ReleaseDC(self.window_handle, hwnd_dc)

                    result = ctypes.windll.user32.PrintWindow(self.window_handle, self.windows_window_save_dc.GetSafeHdc(), 2)
                    bmpinfo = self.windows_window_save_bitmap.GetInfo()
                    bmpstr = self.windows_window_save_bitmap.GetBitmapBits(True)
                    img = Image.frombuffer('RGB', (bmpinfo['bmWidth'], bmpinfo['bmHeight']), bmpstr, 'raw', 'BGRX', 0, 1)

                    x = coord_left
                    y = coord_top
                except pywintypes.error:
                    return False, None

            window_x = 0
            window_y = 0
            window_size_changed = False
            if self.window_size != img.size:
                if self.window_size:
                    window_size_changed = True
                self.window_size = img.size

            if self.window_area_coordinates:
                if window_size_changed:
                    self.current_coordinates = None
                    self.window_area_coordinates = None
                    self.area_mask = None
                    logger.warning('Window size changed, discarding area selection')
                else:
                    img = img.crop(self.window_area_coordinates)
                    window_x, window_y, _, _ = self.window_area_coordinates
                    if x is not None and y is not None:
                        x += window_x
                        y += window_y
        else:
            try:
                self.sct = mss.mss()
            except mss.exception.ScreenShotError:
                return False, None
            sct_img = self.sct.grab(self.sct_params)
            img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
            x = self.sct_params['left']
            y = self.sct_params['top']

        if self.area_mask:
            white_bg = Image.new('RGB', img.size, (255, 255, 255))
            img = Image.composite(img, white_bg, self.area_mask)

        return img, (x, y, self.window_handle, window_x, window_y)

    def cleanup_window_screen_capture(self):
        if sys.platform == 'win32':
            try:
                if self.windows_window_save_bitmap:
                    win32gui.DeleteObject(self.windows_window_save_bitmap.GetHandle())
                    self.windows_window_save_bitmap = None
            except:
                pass
            try:
                if self.windows_window_save_dc:
                    self.windows_window_save_dc.DeleteDC()
                    self.windows_window_save_dc = None
            except:
                pass
            try:
                if self.windows_window_mfc_dc:
                    self.windows_window_mfc_dc.DeleteDC()
                    self.windows_window_mfc_dc = None
            except:
                pass
        elif not self.old_macos_screenshot_api:
            if self.window_stream_configuration:
                self.window_stream_configuration.dealloc()
                self.window_stream_configuration = None
            if self.window_content_filter:
                self.window_content_filter.dealloc()
                self.window_content_filter = None

    def write_result(self, result, is_combo, screen_capture_properties):
        if is_combo:
            image_queue.put((result, True, screen_capture_properties))
        else:
            periodic_screenshot_queue.put((result, screen_capture_properties))

    def launch_coordinate_picker(self, init, must_return):
        if init:
            logger.info('Preloading coordinate picker')
            get_screen_selection(True, None, None, True)
            return
        monitors = self.sct.monitors[1:]
        if self.screencapture_mode != 2:
            logger.info('Launching screen coordinate picker')
            monitor_images = []
            for monitor in monitors:
                try:
                    sct_img = self.sct.grab(monitor)
                except mss.exception.ScreenShotError:
                    exit_with_error(f'Error initializing picker window')
                img = Image.frombytes('RGB', sct_img.size, sct_img.rgb)
                monitor_images.append(img)
            screen_selection = get_screen_selection((monitors, monitor_images), self.current_coordinates, False, self.coordinate_selector_combo_enabled)
            if not screen_selection:
                if must_return:
                    exit_with_error('Picker window was closed or an error occurred')
                else:
                    logger.warning('Picker window was closed or an error occurred, leaving settings unchanged')
                    return

            display_rectangles = None
            if len(screen_selection) == 1:
                coordinates = screen_selection[0]['coordinates']
                monitor = screen_selection[0]['monitor']

                if not coordinates:
                    coord_left = monitor['left']
                    coord_top = monitor['top']
                    coord_width = monitor['width']
                    coord_height = monitor['height']
                else:
                    x1, y1, x2, y2 = coordinates
                    coord_left = x1
                    coord_top = y1
                    coord_width = x2 - x1
                    coord_height = y2 - y1
                    display_rectangles = f'{x1},{y1},{x2},{y2}'

                self.sct_params = {'left': coord_left, 'top': coord_top, 'width': coord_width, 'height': coord_height}
                self.area_mask = None
            else:
                x1, y1, x2, y2 = self.find_minimum_rectangle(screen_selection)
                self.sct_params = {'left': x1, 'top': y1, 'width': x2 - x1, 'height': y2 - y1}
                self.area_mask = self.generate_mask((x1, y1, x2, y2), screen_selection)
                display_rectangles = '_'.join([','.join(map(str, r['coordinates'])) for r in screen_selection])

            if display_rectangles:
                logger.info(f'Selected coordinates: {display_rectangles}')
                self.current_coordinates = screen_selection
            else:
                logger.info('Selection is empty, selecting whole screen')
                self.current_coordinates = None
        else:
            self.window_area_coordinates = None
            self.area_mask = None
            logger.info('Launching window coordinate picker')
            img, _ = self.take_screenshot(True)
            if not img:
                window_selection = False
            else:
                window_selection = get_screen_selection((monitors, img), self.current_coordinates, True, self.coordinate_selector_combo_enabled)
            if not window_selection:
                logger.warning('Picker window was closed or an error occurred, selecting whole window')
                self.current_coordinates = None
            else:
                display_rectangles = None
                if len(window_selection) == 1:
                    coordinates = window_selection[0]['coordinates']
                    if coordinates:
                        x1, y1, x2, y2 = coordinates
                        display_rectangles = f'{x1},{y1},{x2},{y2}'
                else:
                    x1, y1, x2, y2 = self.find_minimum_rectangle(window_selection)
                    self.area_mask = self.generate_mask((x1, y1, x2, y2), window_selection)
                    display_rectangles = '_'.join([','.join(map(str, r['coordinates'])) for r in window_selection])

                if display_rectangles:
                    logger.info(f'Selected window coordinates: {display_rectangles}')
                    self.current_coordinates = window_selection
                    self.window_area_coordinates = (x1, y1, x2, y2)
                else:
                    logger.info('Selection is empty, selecting whole window')
                    self.current_coordinates = None

    def run(self):
        if self.screencapture_mode != 2:
            try:
                self.sct = mss.mss()
            except mss.exception.ScreenShotError as e:
                exit_with_error(f'Error initializing screenshots: {e}')
        while not terminated.is_set():
            if coordinate_selector_event.is_set():
                self.launch_coordinate_picker(False, False)
                coordinate_selector_event.clear()

            try:
                is_combo = screenshot_request_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            img, screen_capture_properties = self.take_screenshot(False)
            self.write_result(img, is_combo, screen_capture_properties)

            if img == False:
                logger.info('The window was closed or an error occurred')
                terminate_handler()
                break

        if self.screencapture_mode == 2:
            self.cleanup_window_screen_capture()
        if self.macos_window_tracker_instance:
            self.macos_window_tracker_instance.join()
        elif self.windows_window_tracker_instance:
            self.windows_window_tracker_instance.join()


class AutopauseTimer:
    def __init__(self):
        self.timeout = config.get_general('auto_pause')
        self.timer_thread = threading.Thread(target=self._countdown, daemon=True)
        self.running = True
        self.countdown_active = threading.Event()
        self.allow_auto_pause = threading.Event()
        self.seconds_remaining = 0
        self.lock = threading.Lock()
        self.timer_thread.start()

    def start_timer(self):
        with self.lock:
            self.seconds_remaining = self.timeout
        self.allow_auto_pause.set()
        self.countdown_active.set()

    def stop_timer(self):
        self.countdown_active.clear()
        self.allow_auto_pause.set()

    def stop(self):
        self.running = False
        self.allow_auto_pause.set()
        self.countdown_active.set()
        if self.timer_thread.is_alive():
            self.timer_thread.join()

    def _countdown(self):
        while self.running:
            self.countdown_active.wait()
            if not self.running:
                break

            while self.running and self.countdown_active.is_set() and self.seconds_remaining > 0:
                time.sleep(1)
                with self.lock:
                    self.seconds_remaining -= 1

            self.allow_auto_pause.wait()

            if self.running and self.countdown_active.is_set() and self.seconds_remaining == 0:
                self.countdown_active.clear()
                if not (paused.is_set() or terminated.is_set()):
                    pause_handler(True)


class SecondPassThread:
    def __init__(self):
        self.input_queue = queue.Queue()
        self.output_queue = queue.Queue()
        self.ocr_thread = None
        self.running = False

    def start(self):
        if self.ocr_thread is None or not self.ocr_thread.is_alive():
            self.running = True
            self.ocr_thread = threading.Thread(target=self._process_ocr, daemon=True)
            self.ocr_thread.start()

    def stop(self):
        self.running = False
        if self.ocr_thread and self.ocr_thread.is_alive():
            self.ocr_thread.join()
        while not self.input_queue.empty():
            self.input_queue.get()
        while not self.output_queue.empty():
            self.output_queue.get()

    def _process_ocr(self):
        while self.running:
            try:
                img, engine_index_local, recovered_lines_count = self.input_queue.get(timeout=0.5)

                engine_instance = engine_instances[engine_index_local]
                start_time = time.time()
                res, result_data = engine_instance(img)
                end_time = time.time()

                self.output_queue.put((engine_instance.readable_name, res, result_data, end_time - start_time, recovered_lines_count))
            except queue.Empty:
                continue

    def submit_task(self, img, engine_instance, recovered_lines_count):
        self.input_queue.put((img, engine_instance, recovered_lines_count))

    def get_result(self):
        try:
            return self.output_queue.get_nowait()
        except queue.Empty:
            return None


class OutputResult:
    def __init__(self):
        self.screen_capture_periodic = config.get_general('screen_capture_delay_seconds') != -1
        self.json_output = config.get_general('output_format') == 'json'
        self.engine_color = config.get_general('engine_color')
        self.verbosity = config.get_general('verbosity')
        self.notifications = config.get_general('notifications')
        self.reorder_text = config.get_general('reorder_text')
        self.line_separator = '' if config.get_general('join_lines') else config.get_general('line_separator').encode().decode('unicode_escape')
        self.paragraph_separator = '' if config.get_general('join_paragraphs') else config.get_general('paragraph_separator').encode().decode('unicode_escape')
        self.write_to = config.get_general('write_to')
        self.filtering = TextFiltering()
        self.second_pass_thread = SecondPassThread()

    def _post_process(self, text, strip_spaces):
        line_separator = '' if strip_spaces else self.line_separator
        paragraphs = []

        current_paragraph = []
        for line in text:
            if line == '\n':
                if current_paragraph:
                    paragraph = line_separator.join(current_paragraph)
                    paragraphs.append(paragraph)
                    current_paragraph = []
                continue
            line = line.replace('…', '...')
            line = re.sub('[・.]{2,}', lambda x: (x.end() - x.start()) * '.', line)
            is_cj_text = self.filtering.cj_regex.search(line)
            if is_cj_text:
                current_paragraph.append(jaconv.h2z(''.join(line.split()), ascii=True, digit=True))
            else:
                current_paragraph.append(re.sub(r'\s+', ' ', line).strip())

        if current_paragraph:
            paragraph = line_separator.join(current_paragraph)
            paragraphs.append(paragraph)

        text = self.paragraph_separator.join(paragraphs)
        return text

    def _extract_lines_from_result(self, result_data):
        lines = []
        for p in result_data.paragraphs:
            for l in p.lines:
                lines.append(self.filtering.get_line_text(l))
            lines.append('\n')
        return lines

    def _copy_to_clipboard(self, string):
        if sys.platform == 'win32':
            wait_counter = 0
            while True:
                try:
                    win32clipboard.OpenClipboard()
                    break
                except pywintypes.error:
                    pass
                if wait_counter == 3:
                    return
                time.sleep(0.1)
                wait_counter += 1
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, string)
            except pywintypes.error:
                pass
            try:
                win32clipboard.CloseClipboard()
            except pywintypes.error:
                pass
        elif sys.platform == 'Darwin':
            with objc.autorelease_pool():
                pb = NSPasteboard.generalPasteboard()
                pb.clearContents()
                ns_string = NSString.stringWithString_(string)
                pb.writeObjects_([ns_string])
        else:
            pyperclipfix.copy(string)

    def _send_output(self, string):
        if self.write_to == 'websocket':
            websocket_server_thread.send_text(string)
        elif self.write_to == 'clipboard':
            self._copy_to_clipboard(string)
        else:
            with Path(self.write_to).open('a', encoding='utf-8') as f:
                f.write(string + '\n')

    def __call__(self, img_or_path, screen_capture_properties, filter_text, auto_pause, notify):
        engine_index_local = engine_index
        engine_instance = engine_instances[engine_index_local]
        two_pass_processing_active = False
        result_data = None

        if filter_text and self.screen_capture_periodic:
            if engine_index_2 != -1 and engine_index_2 != engine_index_local and engine_instance.threading_support:
                two_pass_processing_active = True
                engine_instance_2 = engine_instances[engine_index_2]
                start_time = time.time()
                res2, result_data_2 = engine_instance_2(img_or_path)
                end_time = time.time()

                if not res2:
                    logger.opt(colors=True).warning(f'<{self.engine_color}>{engine_instance_2.readable_name}</> reported an error after {end_time - start_time:0.03f}s: {result_data_2}')
                else:
                    changed_lines_count, recovered_lines_count, changed_regions_image = self.filtering.find_changed_lines(img_or_path, result_data_2)

                    if changed_lines_count or recovered_lines_count:
                        if self.verbosity != 0:
                            logger.opt(colors=True).info(f"<{self.engine_color}>{engine_instance_2.readable_name}</> found {changed_lines_count + recovered_lines_count} changed line(s) in {end_time - start_time:0.03f}s, re-OCRing with <{self.engine_color}>{engine_instance.readable_name}</>")

                        if changed_regions_image:
                            img_or_path = changed_regions_image

                        self.second_pass_thread.start()
                        self.second_pass_thread.submit_task(img_or_path, engine_index_local, recovered_lines_count)

                second_pass_result = self.second_pass_thread.get_result()
                if second_pass_result:
                    engine_name, res, result_data, processing_time, recovered_lines_count = second_pass_result
                else:
                    return
            else:
                self.second_pass_thread.stop()

        if auto_pause_handler and auto_pause:
            auto_pause_handler.allow_auto_pause.clear()

        if not result_data:
            start_time = time.time()
            res, result_data = engine_instance(img_or_path)
            end_time = time.time()
            processing_time = end_time - start_time
            engine_name = engine_instance.readable_name
            recovered_lines_count = 0

        if not res:
            if auto_pause_handler and auto_pause:
                auto_pause_handler.stop_timer()
            logger.opt(colors=True).warning(f'<{self.engine_color}>{engine_name}</> reported an error after {processing_time:0.03f}s: {result_data}')
            return

        if isinstance(result_data, OcrResult):
            if screen_capture_properties:
                x, y, window_handle, window_x, window_y = screen_capture_properties
                if x is not None and y is not None:
                    result_data.image_properties.x = int(x)
                    result_data.image_properties.y = int(y)
                if window_handle:
                    result_data.image_properties.window_handle = int(window_handle)
                if window_x is not None and window_y is not None:
                    result_data.image_properties.window_x = int(window_x)
                    result_data.image_properties.window_y = int(window_y)
            if self.reorder_text:
                result_data = self.filtering.order_paragraphs_and_lines(result_data)
            result_data_text = self._extract_lines_from_result(result_data)
        else:
            result_data_text = result_data

        if filter_text:
            changed_lines, changed_lines_count = self.filtering.find_changed_lines_text(result_data_text, two_pass_processing_active, recovered_lines_count)
            if self.screen_capture_periodic and not changed_lines_count:
                if auto_pause_handler and auto_pause:
                    auto_pause_handler.allow_auto_pause.set()
                return
            output_text = self._post_process(changed_lines, True)
        else:
            output_text = self._post_process(result_data_text, False)

        if self.json_output:
            output_string = json.dumps(asdict(result_data), ensure_ascii=False)
        else:
            output_string = output_text

        if self.verbosity != 0:
            if self.verbosity < -1:
                log_message = ': ' + output_text
            elif self.verbosity == -1:
                log_message = ''
            else:
                log_message = ': ' + (output_text if len(output_text) <= self.verbosity else output_text[:self.verbosity] + '[...]')

            logger.opt(colors=True).info(f'Text recognized in {processing_time:0.03f}s using <{self.engine_color}>{engine_name}</>{log_message}')

        if notify and self.notifications:
            notifier.send(title='owocr', message='Text recognized: ' + output_text, urgency=get_notification_urgency())

        self._send_output(output_string)

        if auto_pause_handler and auto_pause:
            if not paused.is_set():
                auto_pause_handler.start_timer()
            else:
                auto_pause_handler.stop_timer()


def get_notification_urgency():
    if sys.platform == 'win32':
        return Urgency.Low
    return Urgency.Normal


def pause_handler(is_combo=True):
    global paused
    message = 'Unpaused!' if paused.is_set() else 'Paused!'

    if auto_pause_handler:
        auto_pause_handler.stop_timer()
    if is_combo:
        notifier.send(title='owocr', message=message, urgency=get_notification_urgency())
    logger.info(message)
    paused.clear() if paused.is_set() else paused.set()


def engine_change_handler(user_input='s', is_combo=True):
    global engine_index
    old_engine_index = engine_index

    if user_input.lower() == 's':
        if engine_index == len(engine_keys) - 1:
            engine_index = 0
        else:
            engine_index += 1
    elif user_input.lower() != '' and user_input.lower() in engine_keys:
        engine_index = engine_keys.index(user_input.lower())
    if engine_index != old_engine_index:
        new_engine_name = engine_instances[engine_index].readable_name
        if is_combo:
            notifier.send(title='owocr', message=f'Switched to {new_engine_name}', urgency=get_notification_urgency())
        engine_color = config.get_general('engine_color')
        logger.opt(colors=True).info(f'Switched to <{engine_color}>{new_engine_name}</>!')


def terminate_handler(sig=None, frame=None):
    global terminated
    if not terminated.is_set():
        logger.info('Terminated!')
        terminated.set()


def exit_with_error(error):
    logger.error(error)
    terminate_handler()
    sys.exit(1)


def user_input_thread_run():
    if sys.platform == 'win32':
        import msvcrt
        while not terminated.is_set():
            if coordinate_selector_event.is_set():
                while coordinate_selector_event.is_set():
                    time.sleep(0.1)
            if msvcrt.kbhit():
                try:
                    user_input_bytes = msvcrt.getch()
                    user_input = user_input_bytes.decode()
                    if user_input.lower() in 'tq':
                        terminate_handler()
                    elif user_input.lower() == 'p':
                        pause_handler(False)
                    else:
                        engine_change_handler(user_input, False)
                except UnicodeDecodeError:
                    pass
            else:
                time.sleep(0.2)
    else:
        import termios, select
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        new_settings = termios.tcgetattr(fd)
        new_settings[0] &= ~termios.IXON
        new_settings[3] &= ~(termios.ICANON | termios.ECHO)
        new_settings[6][termios.VMIN] = 1
        new_settings[6][termios.VTIME] = 0
        try:
            termios.tcsetattr(fd, termios.TCSANOW, new_settings)
            while not terminated.is_set():
                if coordinate_selector_event.is_set():
                    while coordinate_selector_event.is_set():
                        time.sleep(0.1)
                    termios.tcsetattr(fd, termios.TCSANOW, new_settings)
                rlist, _, _ = select.select([sys.stdin], [], [], 0.2)
                if rlist:
                    user_input = sys.stdin.read(1)
                    if user_input.lower() in 'tq':
                        terminate_handler()
                    elif user_input.lower() == 'p':
                        pause_handler(False)
                    else:
                        engine_change_handler(user_input, False)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def on_screenshot_combo():
    screenshot_request_queue.put(True)


def on_coordinate_selector_combo():
    coordinate_selector_event.set()


def get_current_version():
    try:
        return importlib.metadata.version(__package__)
    except:
        return 'N/A'


def get_latest_version():
    try:
        with urllib.request.urlopen(f'https://pypi.org/pypi/{__package__}/json', timeout=5) as response:
            data = json.load(response)
            return data['info']['version']
    except:
        return 'N/A'


def run():
    logger_level = 'DEBUG' if config.get_general('uwu') else 'INFO'
    logger.configure(handlers=[{'sink': sys.stderr, 'format': config.get_general('logger_format'), 'level': logger_level}])

    logger.info(f'Starting owocr version {get_current_version()}')
    logger.info(f'Latest available version: {get_latest_version()}')
    if config.has_config:
        logger.info('Parsed config file')
    else:
        logger.warning('No config file, defaults will be used')
        if config.downloaded_config:
            logger.info(f'A default config file has been downloaded to {config.config_path}')

    global engine_instances
    global engine_keys
    output_format = config.get_general('output_format')
    engines_setting = config.get_general('engines')
    default_engine_setting = config.get_general('engine')
    secondary_engine_setting = config.get_general('engine_secondary')
    language = config.get_general('language')
    engine_instances = []
    config_engines = []
    engine_keys = []
    default_engine = ''
    engine_secondary = ''

    if len(engines_setting) > 0:
        for config_engine in engines_setting.split(','):
            config_engines.append(config_engine.strip().lower())

    for _,engine_class in sorted(inspect.getmembers(sys.modules[__name__], lambda x: hasattr(x, '__module__') and x.__module__ and __package__ + '.ocr' in x.__module__ and inspect.isclass(x) and hasattr(x, 'name'))):
        if len(config_engines) == 0 or engine_class.name in config_engines:

            if output_format == 'json' and not engine_class.coordinate_support:
                logger.warning(f"Skipping {engine_class.readable_name} as it does not support JSON output")
                continue

            if not engine_class.config_entry:
                if engine_class.manual_language:
                    engine_instance = engine_class(language=language)
                else:
                    engine_instance = engine_class()
            else:
                if engine_class.manual_language:
                    engine_instance = engine_class(config=config.get_engine(engine_class.config_entry), language=language)
                else:
                    engine_instance = engine_class(config=config.get_engine(engine_class.config_entry))

            if engine_instance.available:
                engine_instances.append(engine_instance)
                engine_keys.append(engine_class.key)
                if default_engine_setting == engine_class.name:
                    default_engine = engine_class.key
                if secondary_engine_setting == engine_class.name and engine_class.local and engine_class.coordinate_support:
                    engine_secondary = engine_class.key

    if len(engine_keys) == 0:
        exit_with_error('No engines available!')

    if default_engine_setting and not default_engine:
        logger.warning("Couldn't find selected engine, using the first one in the list")

    if secondary_engine_setting and not engine_secondary:
        logger.warning("Couldn't find selected secondary engine, make sure it's enabled, local and has JSON format support. Disabling two pass processing")

    global engine_index
    global engine_index_2
    global terminated
    global paused
    global notifier
    global auto_pause_handler
    global websocket_server_thread
    global screenshot_thread
    global image_queue
    global coordinate_selector_event
    non_path_inputs = ('screencapture', 'clipboard', 'websocket', 'unixsocket')
    read_from = config.get_general('read_from')
    read_from_secondary = config.get_general('read_from_secondary')
    read_from_path = None
    read_from_readable = []
    write_to = config.get_general('write_to')
    terminated = threading.Event()
    paused = threading.Event()
    if config.get_general('pause_at_startup'):
        paused.set()
    auto_pause = config.get_general('auto_pause')
    clipboard_thread = None
    websocket_server_thread = None
    screenshot_thread = None
    directory_watcher_thread = None
    unix_socket_server = None
    key_combo_listener = None
    auto_pause_handler = None
    engine_index = engine_keys.index(default_engine) if default_engine != '' else 0
    engine_index_2 = engine_keys.index(engine_secondary) if engine_secondary != '' else -1
    engine_color = config.get_general('engine_color')
    combo_pause = config.get_general('combo_pause')
    combo_engine_switch = config.get_general('combo_engine_switch')
    screen_capture_periodic = False
    screen_capture_on_combo = False
    coordinate_selector_event = threading.Event()
    notifier = DesktopNotifierSync()
    image_queue = queue.Queue()
    key_combos = {}

    if combo_pause != '':
        key_combos[combo_pause] = pause_handler
    if combo_engine_switch != '':
        key_combos[combo_engine_switch] = engine_change_handler

    if 'websocket' in (read_from, read_from_secondary) or write_to == 'websocket':
        websocket_port = config.get_general('websocket_port')
        logger.info(f"Starting websocket server on port {websocket_port}")
        websocket_server_thread = WebsocketServerThread('websocket' in (read_from, read_from_secondary))
        websocket_server_thread.start()
    if 'screencapture' in (read_from, read_from_secondary):
        global screenshot_request_queue
        screen_capture_delay_seconds = config.get_general('screen_capture_delay_seconds')
        screen_capture_combo = config.get_general('screen_capture_combo')
        coordinate_selector_combo = config.get_general('coordinate_selector_combo')
        last_screenshot_time = 0
        if screen_capture_combo != '':
            screen_capture_on_combo = True
            key_combos[screen_capture_combo] = on_screenshot_combo
        if coordinate_selector_combo != '':
            key_combos[coordinate_selector_combo] = on_coordinate_selector_combo
        if screen_capture_delay_seconds != -1:
            global periodic_screenshot_queue
            periodic_screenshot_queue = queue.Queue()
            screen_capture_periodic = True
        if not (screen_capture_on_combo or screen_capture_periodic):
            exit_with_error('screen_capture_delay_seconds or screen_capture_combo need to be valid values')
        screenshot_request_queue = queue.Queue()
        screenshot_thread = ScreenshotThread()
        screenshot_thread.start()
        read_from_readable.append('screen capture')
    if 'websocket' in (read_from, read_from_secondary):
        read_from_readable.append('websocket')
    if 'unixsocket' in (read_from, read_from_secondary):
        if sys.platform == 'win32':
            exit_with_error('"unixsocket" is not currently supported on Windows')
        socket_path = Path('/tmp/owocr.sock')
        if socket_path.exists():
            try:
                test_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                test_socket.connect(str(socket_path))
                test_socket.close()
                exit_with_error('Unix domain socket is already in use')
            except ConnectionRefusedError:
                socket_path.unlink()
        unix_socket_server = socketserver.ThreadingUnixStreamServer(str(socket_path), UnixSocketRequestHandler)
        unix_socket_server_thread = threading.Thread(target=unix_socket_server.serve_forever, daemon=True)
        unix_socket_server_thread.start()
        read_from_readable.append('unix socket')
    if 'clipboard' in (read_from, read_from_secondary):
        clipboard_thread = ClipboardThread()
        clipboard_thread.start()
        read_from_readable.append('clipboard')
    if any(i and i not in non_path_inputs for i in (read_from, read_from_secondary)):
        if all(i and i not in non_path_inputs for i in (read_from, read_from_secondary)):
            exit_with_error("read_from and read_from_secondary can't both be directory paths")
        delete_images = config.get_general('delete_images')
        read_from_path = Path(read_from) if read_from not in non_path_inputs else Path(read_from_secondary)
        if not read_from_path.is_dir():
            exit_with_error('read_from and read_from_secondary must be either "websocket", "unixsocket", "clipboard", "screencapture", or a path to a directory')
        directory_watcher_thread = DirectoryWatcher(read_from_path)
        directory_watcher_thread.start()
        read_from_readable.append(f'directory {read_from_path}')

    output_result = OutputResult()

    if len(key_combos) > 0:
        key_combo_listener = keyboard.GlobalHotKeys(key_combos)
        key_combo_listener.start()

    if write_to in ('clipboard', 'websocket'):
        write_to_readable = write_to
    else:
        if Path(write_to).suffix.lower() != '.txt':
            exit_with_error('write_to must be either "websocket", "clipboard" or a path to a text file')
        write_to_readable = f'file {write_to}'

    process_queue = (any(i in ('clipboard', 'websocket', 'unixsocket') for i in (read_from, read_from_secondary)) or read_from_path or screen_capture_on_combo)
    signal.signal(signal.SIGINT, terminate_handler)
    if auto_pause != 0:
        auto_pause_handler = AutopauseTimer()
    user_input_thread = threading.Thread(target=user_input_thread_run, daemon=True)
    user_input_thread.start()

    if not terminated.is_set():
        logger.opt(colors=True).info(f"Reading from {' and '.join(read_from_readable)}, writing to {write_to_readable} using <{engine_color}>{engine_instances[engine_index].readable_name}</>{' (paused)' if paused.is_set() else ''}")

    while not terminated.is_set():
        img = None
        skip_waiting = False
        filter_text = False
        auto_pause = True
        notify = False

        if process_queue:
            try:
                img, is_screen_capture, screen_capture_properties = image_queue.get_nowait()
                if not screen_capture_periodic and is_screen_capture:
                    filter_text = True
                if is_screen_capture:
                    auto_pause = False
                notify = True
            except queue.Empty:
                pass

        if img is None and screen_capture_periodic:
            if (not paused.is_set()) and (time.time() - last_screenshot_time) > screen_capture_delay_seconds:
                if periodic_screenshot_queue.empty() and screenshot_request_queue.empty():
                    screenshot_request_queue.put(False)
                try:
                    img, screen_capture_properties = periodic_screenshot_queue.get(timeout=0.5)
                    filter_text = True
                    last_screenshot_time = time.time()
                except queue.Empty:
                    skip_waiting = True
                    pass

        if img:
            output_result(img, screen_capture_properties, filter_text, auto_pause, notify)
            if isinstance(img, Path) and delete_images:
                Path.unlink(img)

        if not img and not skip_waiting:
            time.sleep(0.1)

    terminate_selector_if_running()
    user_input_thread.join()
    output_result.second_pass_thread.stop()
    if auto_pause_handler:
        auto_pause_handler.stop()
    if websocket_server_thread:
        websocket_server_thread.stop_server()
        websocket_server_thread.join()
    if clipboard_thread:
        if sys.platform == 'win32':
            win32api.PostThreadMessage(clipboard_thread.thread_id, win32con.WM_QUIT, 0, 0)
        clipboard_thread.join()
    if directory_watcher_thread:
        directory_watcher_thread.join()
    if unix_socket_server:
        unix_socket_server.shutdown()
        unix_socket_server_thread.join()
    if screenshot_thread:
        screenshot_thread.join()
    if key_combo_listener:
        key_combo_listener.stop()
