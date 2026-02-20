import re
import os
import io
import sys
import platform
import logging
import json
import base64
import urllib
import inspect
import time
from contextlib import contextmanager
from pathlib import Path
from math import sqrt, sin, cos, atan2, radians
from urllib.parse import urlparse, parse_qs
from dataclasses import dataclass, field, asdict
from typing import List, Optional

import numpy as np
from PIL import Image
from loguru import logger
import curl_cffi

try:
    import fpng_py_fix
    optimized_png_encode = True
except:
    optimized_png_encode = False

manga_ocr_model = None


@dataclass
class BoundingBox:
    """
    Represents the normalized coordinates of a detected element.
    All values are floats between 0.0 and 1.0.
    """
    center_x: float
    center_y: float
    width: float
    height: float
    rotation_z: Optional[float] = None  # Optional rotation in radians

    @property
    def left(self) -> float:
        return self.center_x - self.width / 2

    @property
    def right(self) -> float:
        return self.center_x + self.width / 2

    @property
    def top(self) -> float:
        return self.center_y - self.height / 2

    @property
    def bottom(self) -> float:
        return self.center_y + self.height / 2

@dataclass
class Word:
    """Represents a single recognized word and its properties."""
    text: str
    bounding_box: BoundingBox
    separator: Optional[str] = None  # The character(s) that follow the word, e.g., a space

@dataclass
class Line:
    """Represents a single line of text, composed of words."""
    bounding_box: BoundingBox
    words: List[Word] = field(default_factory=list)
    text: Optional[str] = None # Optional: The entire text line, as reported by the OCR engine

@dataclass
class Paragraph:
    """Represents a block of text, composed of lines."""
    bounding_box: BoundingBox
    lines: List[Line] = field(default_factory=list)
    writing_direction: Optional[str] = None # Optional: e.g., "LEFT_TO_RIGHT"

@dataclass
class ImageProperties:
    """Stores the original dimensions of the processed image."""
    width: int
    height: int
    x: Optional[int] = None # Optional: X position of the scanned area relative to the screen(s)
    y: Optional[int] = None # Optional: Y position of the scanned area relative to the screen(s)
    window_handle: Optional[int] = None # Optional: handle of the scanned window
    window_x: Optional[int] = None # Optional: X position of the scanned area relative to the window
    window_y: Optional[int] = None # Optional: Y position of the scanned area relative to the window

@dataclass
class EngineCapabilities:
    """Represents the features natively supported by the OCR engine."""
    words: bool
    word_bounding_boxes: bool
    lines: bool
    line_bounding_boxes: bool
    paragraphs: bool
    paragraph_bounding_boxes: bool

@dataclass
class OcrResult:
    """The root object for a complete OCR analysis of an image."""
    image_properties: ImageProperties
    engine_capabilities: EngineCapabilities
    paragraphs: List[Paragraph] = field(default_factory=list)

@contextmanager
def suppress_output():
    devnull = os.open(os.devnull, os.O_WRONLY)
    original_stdout = os.dup(1)
    original_stderr = os.dup(2)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    try:
        yield
    finally:
        os.dup2(original_stdout, 1)
        os.dup2(original_stderr, 2)
        os.close(original_stdout)
        os.close(original_stderr)
        os.close(devnull)


def initialize_manga_ocr(pretrained_model_name_or_path, force_cpu):
    def empty_post_process(text):
        text = re.sub(r'\s+', '', text)
        return text

    global manga_ocr_model
    if not manga_ocr_model:
        logger.disable('manga_ocr')
        from manga_ocr import ocr
        ocr.post_process = empty_post_process
        logger.info(f'Loading Manga OCR model')
        manga_ocr_model = MOCR(pretrained_model_name_or_path, force_cpu)

def input_to_pil_image(img):
    is_path = False
    if isinstance(img, Image.Image):
        pil_image = img
    elif isinstance(img, (bytes, bytearray)):
        try:
            pil_image = Image.open(io.BytesIO(img))
        except (Image.UnidentifiedImageError, OSError):
            return None, False
    elif isinstance(img, Path):
        is_path = True
        try:
            pil_image = Image.open(img)
            pil_image.load()
        except (Image.UnidentifiedImageError, OSError):
            return None, False
    else:
        raise ValueError(f'img must be a path, PIL.Image or bytes object, instead got: {img}')
    return pil_image, is_path

def pil_image_to_bytes(img, img_format='png', png_compression=6, jpeg_quality=80, optimize=False):
    if img_format == 'png' and optimized_png_encode and not optimize:
        raw_data = img.convert('RGBA').tobytes()
        image_bytes = fpng_py_fix.fpng_encode_image_to_memory(raw_data, img.width, img.height)
    else:
        image_bytes = io.BytesIO()
        if img_format == 'jpeg':
            img = img.convert('RGB')
        img.save(image_bytes, format=img_format, compress_level=png_compression, quality=jpeg_quality, optimize=optimize, subsampling=0)
        image_bytes = image_bytes.getvalue()
    return image_bytes

def pil_image_to_numpy_array(img):
    return np.array(img.convert('RGBA'))

def limit_image_size(img, max_size):
    img_bytes = pil_image_to_bytes(img)
    if len(img_bytes) <= max_size:
        return img_bytes, 'png', img.size

    scaling_factor = 0.60 if any(x > 2000 for x in img.size) else 0.75
    new_w = int(img.width * scaling_factor)
    new_h = int(img.height * scaling_factor)
    resized_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    resized_img_bytes = pil_image_to_bytes(resized_img)
    if len(resized_img_bytes) <= max_size:
        return resized_img_bytes, 'png', resized_img.size

    for _ in range(2):
        jpeg_quality = 80
        while jpeg_quality >= 60:
            img_bytes = pil_image_to_bytes(img, 'jpeg', jpeg_quality=jpeg_quality, optimize=True)
            if len(img_bytes) <= max_size:
                return img_bytes, 'jpeg', img.size
            jpeg_quality -= 5
        img = resized_img

    return False, '', (None, None)

def quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width=None, img_height=None):
    center_x = (x1 + x2 + x3 + x4) / 4
    center_y = (y1 + y2 + y3 + y4) / 4

    # Calculate widths using Euclidean distance
    width1 = sqrt((x2 - x1)**2 + (y2 - y1)**2)
    width2 = sqrt((x3 - x4)**2 + (y3 - y4)**2)
    avg_width = (width1 + width2) / 2

    # Calculate heights using Euclidean distance
    height1 = sqrt((x4 - x1)**2 + (y4 - y1)**2)
    height2 = sqrt((x3 - x2)**2 + (y3 - y2)**2)
    avg_height = (height1 + height2) / 2

    # Calculate rotation angle from the first edge
    dx = x2 - x1
    dy = y2 - y1
    angle = atan2(dy, dx)

    if img_width and img_height:
        center_x = center_x / img_width
        center_y = center_y / img_height
        avg_width = avg_width / img_width
        avg_height = avg_height / img_height

    return BoundingBox(
        center_x=center_x,
        center_y=center_y,
        width=avg_width,
        height=avg_height,
        rotation_z=angle
    )

def rectangle_to_bounding_box(x1, y1, x2, y2, img_width=None, img_height=None):
    width = x2 - x1
    height = y2 - y1

    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2

    if img_width and img_height:
        width = width / img_width
        height = height / img_height
        center_x = center_x / img_width
        center_y = center_y / img_height

    return BoundingBox(
        center_x=center_x,
        center_y=center_y,
        width=width,
        height=height
    )

def merge_bounding_boxes(ocr_element_list, rotated=False):
    def _get_all_corners(ocr_element_list):
        corners = []
        for element in ocr_element_list:
            bbox = element.bounding_box
            angle = bbox.rotation_z or 0.0
            hw, hh = bbox.width / 2.0, bbox.height / 2.0
            cx, cy = bbox.center_x, bbox.center_y

            # Local corner offsets
            local = np.array([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])

            if abs(angle) < 1e-12:
                corners.append(local + [cx, cy])
            else:
                # Rotation matrix
                cos_a, sin_a = np.cos(angle), np.sin(angle)
                rot = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
                corners.append(local @ rot.T + [cx, cy])

        return np.vstack(corners) if corners else np.empty((0, 2))

    def _convex_hull(points):
        if len(points) <= 3:
            return points

        pts = np.unique(points, axis=0)
        pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

        if len(pts) <= 1:
            return pts

        def cross(o, a, b):
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

        lower, upper = [], []
        for p in pts:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
                lower.pop()
            lower.append(p)
        for p in pts[::-1]:
            while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
                upper.pop()
            upper.append(p)

        return np.array(lower[:-1] + upper[:-1])

    all_corners = _get_all_corners(ocr_element_list)

    # Axis-aligned case
    if not rotated:
        min_pt, max_pt = all_corners.min(axis=0), all_corners.max(axis=0)
        center = (min_pt + max_pt) / 2
        size = max_pt - min_pt
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=size[0],
            height=size[1]
        )

    hull = _convex_hull(all_corners)
    m = len(hull)

    # Trivial cases
    if m == 1:
        return BoundingBox(
            center_x=hull[0, 0],
            center_y=hull[0, 1],
            width=0.0,
            height=0.0,
            rotation_z=0.0
        )

    if m == 2:
        diff = hull[1] - hull[0]
        length = np.linalg.norm(diff)
        center = hull.mean(axis=0)
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=length,
            height=0.0,
            rotation_z=np.arctan2(diff[1], diff[0])
        )

    # Test each edge orientation
    edges = np.roll(hull, -1, axis=0) - hull
    edge_lengths = np.linalg.norm(edges, axis=1)
    valid = edge_lengths > 1e-12

    if not valid.any():
        # Fallback to axis-aligned
        min_pt, max_pt = all_corners.min(axis=0), all_corners.max(axis=0)
        center = (min_pt + max_pt) / 2
        size = max_pt - min_pt
        return BoundingBox(
            center_x=center[0],
            center_y=center[1],
            width=size[0],
            height=size[1]
        )

    angles = np.arctan2(edges[valid, 1], edges[valid, 0])
    best_area, best_idx = np.inf, -1

    for idx, angle in enumerate(angles):
        # Rotation matrix (rotate by -angle)
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        rot = np.array([[cos_a, sin_a], [-sin_a, cos_a]])
        rotated = hull @ rot.T

        min_pt, max_pt = rotated.min(axis=0), rotated.max(axis=0)
        area = np.prod(max_pt - min_pt)

        if area < best_area:
            best_area, best_idx = area, idx
            best_bounds = (min_pt, max_pt, angle)

    min_pt, max_pt, angle = best_bounds
    width, height = max_pt - min_pt
    center_rot = (min_pt + max_pt) / 2

    # Rotate center back to global coordinates
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    rot_back = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
    center = rot_back @ center_rot

    # Normalize angle to [-π, π]
    angle = np.mod(angle + np.pi, 2 * np.pi) - np.pi

    return BoundingBox(
        center_x=center[0],
        center_y=center[1],
        width=width,
        height=height,
        rotation_z=angle
    )


class GlobalImport:
    def _silence_warnings(self):
        logging.getLogger('transformers').setLevel(logging.ERROR) # silence transformers >=4.46 warnings
        logging.getLogger('huggingface_hub').setLevel(logging.ERROR)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.collector = inspect.getargvalues(inspect.getouterframes(inspect.currentframe())[1].frame).locals
        globals().update(self.collector)
        self._silence_warnings()

class MangaOcrSegmented:
    name = 'mangaocrs'
    readable_name = 'Manga OCR (segmented)'
    key = 'n'
    config_entry = 'mangaocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Manga OCR (segmented)')
        if not manga_ocr_model:
            with GlobalImport():
                try:
                    from manga_ocr import MangaOcr as MOCR
                except ImportError:
                    return False
        with GlobalImport():
            try:
                from comic_text_detector.inference import TextDetector
                from scipy.signal.windows import gaussian
                import torch
                import cv2
            except ImportError:
                return False
        return True

    def __init__(self, config={}):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Manga OCR (segmented) will not work!')
        else:
            comic_text_detector_path = Path.home() / ".cache" / "manga-ocr"
            comic_text_detector_file = comic_text_detector_path / "comictextdetector.pt"

            if not comic_text_detector_file.exists():
                comic_text_detector_path.mkdir(parents=True, exist_ok=True)
                logger.info('Downloading comic text detector model ' + str(comic_text_detector_file))
                try:
                    urllib.request.urlretrieve('https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt', str(comic_text_detector_file))
                except:
                    logger.warning('Download failed. Manga OCR (segmented) will not work!')
                    return

            pretrained_model_name_or_path = config.get('pretrained_model_name_or_path', 'kha-white/manga-ocr-base')
            force_cpu = config.get('force_cpu', False)
            initialize_manga_ocr(pretrained_model_name_or_path, force_cpu)

            if not force_cpu and torch.cuda.is_available():
                device = 'cuda'
            elif not force_cpu and torch.backends.mps.is_available():
                device = 'mps'
            else:
                device = 'cpu'
            logger.info(f'Loading comic text detector model, using device {device}')
            self.text_detector_model = TextDetector(model_path=comic_text_detector_file, input_size=1024, device=device, act='leaky')

            self.available = True
            logger.info('Manga OCR (segmented) ready')

    def _convert_line_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _convert_box_bbox(self, rect, img_width, img_height):
        x1, y1, x2, y2 = map(float, rect)
        return rectangle_to_bounding_box(x1, y1, x2, y2, img_width, img_height)

    # from https://github.com/kha-white/mokuro/blob/master/mokuro/manga_page_ocr.py
    def _split_into_chunks(self, img, mask_refined, blk, line_idx, textheight, max_ratio, anchor_window):
        line_crop = blk.get_transformed_region(img, line_idx, textheight)

        h, w, *_ = line_crop.shape
        ratio = w / h

        if ratio <= max_ratio:
            return [line_crop], []
        else:
            k = gaussian(textheight * 2, textheight / 8)

            line_mask = blk.get_transformed_region(mask_refined, line_idx, textheight)
            num_chunks = int(np.ceil(ratio / max_ratio))

            anchors = np.linspace(0, w, num_chunks + 1)[1:-1]

            line_density = line_mask.sum(axis=0)
            line_density = np.convolve(line_density, k, 'same')
            line_density /= line_density.max()

            anchor_window *= textheight

            cut_points = []
            for anchor in anchors:
                anchor = int(anchor)

                n0 = np.clip(anchor - anchor_window // 2, 0, w)
                n1 = np.clip(anchor + anchor_window // 2, 0, w)

                p = line_density[n0:n1].argmin()
                p += n0

                cut_points.append(p)

            return np.split(line_crop, cut_points, axis=1), cut_points

    # derived from https://github.com/kha-white/mokuro/blob/master/mokuro/manga_page_ocr.py
    def _to_generic_result(self, mask_refined, blk_list, img_np, img_height, img_width):
        paragraphs = []
        for blk_idx, blk in enumerate(blk_list):
            lines = []
            for line_idx, line in enumerate(blk.lines_array()):
                if blk.vertical:
                    max_ratio = 16
                else:
                    max_ratio = 8

                line_crops, cut_points = self._split_into_chunks(
                    img_np,
                    mask_refined,
                    blk,
                    line_idx,
                    textheight=64,
                    max_ratio=max_ratio,
                    anchor_window=2,
                )

                l_text = ''
                for line_crop in line_crops:
                    if blk.vertical:
                        line_crop = cv2.rotate(line_crop, cv2.ROTATE_90_CLOCKWISE)
                    l_text += manga_ocr_model(Image.fromarray(line_crop))
                l_bbox = self._convert_line_bbox(line.tolist(), img_width, img_height)

                word = Word(
                    text=l_text,
                    bounding_box=l_bbox
                )
                words = [word]

                line = Line(
                    text=l_text,
                    bounding_box=l_bbox,
                    words=words
                )

                lines.append(line)

            p_bbox = self._convert_box_bbox(list(blk.xyxy), img_width, img_height)
            writing_direction = 'TOP_TO_BOTTOM' if blk.vertical else "LEFT_TO_RIGHT"
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines, writing_direction=writing_direction)

            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_np = pil_image_to_numpy_array(img)
        img_width, img_height = img.size

        _, mask_refined, blk_list = self.text_detector_model(img_np, refine_mode=1, keep_undetected_mask=True)
        ocr_result = self._to_generic_result(mask_refined, blk_list, img_np, img_height, img_width)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

class MangaOcr:
    name = 'mangaocr'
    readable_name = 'Manga OCR'
    key = 'm'
    config_entry = 'mangaocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = False
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Manga OCR')
        if not manga_ocr_model:
            with GlobalImport():
                try:
                    from manga_ocr import MangaOcr as MOCR
                except ImportError:
                    return False
        return True

    def __init__(self, config={}):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Manga OCR will not work!')
        else:
            pretrained_model_name_or_path = config.get('pretrained_model_name_or_path', 'kha-white/manga-ocr-base')
            force_cpu = config.get('force_cpu', False)
            initialize_manga_ocr(pretrained_model_name_or_path, force_cpu)
            self.available = True
            logger.info('Manga OCR ready')

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        x = (True, [manga_ocr_model(img)])

        if is_path:
            img.close()
        return x

class GoogleVision:
    name = 'gvision'
    readable_name = 'Google Vision'
    key = 'g'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Google Vision')
        with GlobalImport():
            try:
                from google.cloud import vision
                from google.oauth2 import service_account
                from google.api_core.exceptions import ServiceUnavailable
            except ImportError:
                return False
        return True

    def __init__(self):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Google Vision will not work!')
        else:
            logger.info(f'Parsing Google credentials')
            google_credentials_file = os.path.join(os.path.expanduser('~'),'.config','google_vision.json')
            try:
                google_credentials = service_account.Credentials.from_service_account_file(google_credentials_file)
                self.client = vision.ImageAnnotatorClient(credentials=google_credentials)
                self.available = True
                logger.info('Google Vision ready')
            except:
                logger.warning('Error parsing Google credentials, Google Vision will not work!')

    def _break_type_to_char(self, break_type):
        if break_type == vision.TextAnnotation.DetectedBreak.BreakType.SPACE:
            return ' '
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.SURE_SPACE:
            return ' '
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.EOL_SURE_SPACE:
            return '\n'
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.HYPHEN:
            return '-'
        elif break_type == vision.TextAnnotation.DetectedBreak.BreakType.LINE_BREAK:
            return '\n'
        return ''

    def _convert_bbox(self, quad, img_width, img_height):
        vertices = quad.vertices

        return quad_to_bounding_box(
            vertices[0].x, vertices[0].y,
            vertices[1].x, vertices[1].y,
            vertices[2].x, vertices[2].y,
            vertices[3].x, vertices[3].y,
            img_width, img_height
        )

    def _create_word_from_google_word(self, google_word, img_width, img_height):
        w_bbox = self._convert_bbox(google_word.bounding_box, img_width, img_height)

        w_separator = ''
        w_text_parts = []
        for i, symbol in enumerate(google_word.symbols):
            separator = None
            if hasattr(symbol, 'property') and hasattr(symbol.property, 'detected_break'):
                detected_break = symbol.property.detected_break
                detected_separator = self._break_type_to_char(detected_break.type_)
                if i == len(google_word.symbols) - 1:
                    w_separator = detected_separator
                else:
                    separator = detected_separator
            symbol_text = symbol.text
            w_text_parts.append(symbol_text)
            if separator:
                w_text_parts.append(separator)
        word_text = ''.join(w_text_parts)

        return Word(
            text=word_text,
            bounding_box=w_bbox,
            separator=w_separator
        )

    def _create_lines_from_google_paragraph(self, google_paragraph, p_bbox, img_width, img_height):
        lines = []
        words = []
        for google_word in google_paragraph.words:
            word = self._create_word_from_google_word(google_word, img_width, img_height)
            words.append(word)
            if word.separator == '\n':
                line = Line(bounding_box=BoundingBox(0,0,0,0), words=words)
                lines.append(line)
                words = []

        if len(lines) == 1:
            lines[0].bounding_box = p_bbox
        else:
            for line in lines:
                l_bbox = merge_bounding_boxes(line.words, True)
                line.bounding_box = l_bbox

        return lines

    def _to_generic_result(self, full_text_annotation, img_width, img_height):
        paragraphs = []

        if full_text_annotation:
            for page in full_text_annotation.pages:
                if page.width == img_width and page.height == img_height:
                    for block in page.blocks:
                        for google_paragraph in block.paragraphs:
                            p_bbox = self._convert_bbox(google_paragraph.bounding_box, img_width, img_height)
                            lines = self._create_lines_from_google_paragraph(google_paragraph, p_bbox, img_width, img_height)
                            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
                            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        image_bytes = self._preprocess(img)
        image = vision.Image(content=image_bytes)

        try:
            response = self.client.document_text_detection(image=image)
        except ServiceUnavailable:
            return (False, 'Connection error!')
        except Exception as e:
            return (False, 'Unknown error!')

        ocr_result = self._to_generic_result(response.full_text_annotation, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img)

class ChromeScreenAI:
    name = 'screenai'
    readable_name = 'Chrome Screen AI'
    key = 'j'
    config_entry = None
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Chrome Screen AI')
        with GlobalImport():
            try:
                import ctypes
                from google.protobuf.json_format import MessageToDict
                from .screenai_protos.chrome_screen_ai_pb2 import VisualAnnotation
            except ImportError:
                return False
            return True

    def __init__(self):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Chrome Screen AI will not work!')
            return

        self.model_dir = os.path.join(os.path.expanduser('~'), '.config', 'screen_ai', 'resources')
        if not os.path.exists(self.model_dir):
            logger.warning(f'Unable to find screen AI files in {self.model_dir}, Chrome Screen AI will not work!')
            return

        @ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_char_p)
        def get_file_content_size(p):
            path = os.path.join(self.model_dir, p.decode('utf-8'))
            return os.path.getsize(path) if os.path.exists(path) else 0

        @ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p)
        def get_file_content(p, s, ptr):
            path = os.path.join(self.model_dir, p.decode('utf-8'))
            if os.path.exists(path):
                with open(path, 'rb') as f:
                    ctypes.memmove(ptr, f.read(s), s)

        class SkColorInfo(ctypes.Structure):
            _fields_ = [('fColorSpace', ctypes.c_void_p), ('fColorType', ctypes.c_int32), ('fAlphaType', ctypes.c_int32)]
        class SkISize(ctypes.Structure):
            _fields_ = [('fWidth', ctypes.c_int32), ('fHeight', ctypes.c_int32)]
        class SkImageInfo(ctypes.Structure):
            _fields_ = [('fColorInfo', SkColorInfo), ('fDimensions', SkISize)]
        class SkPixmap(ctypes.Structure):
            _fields_ = [('fPixels', ctypes.c_void_p), ('fRowBytes', ctypes.c_size_t), ('fInfo', SkImageInfo)]
        class SkBitmap(ctypes.Structure):
            _fields_ = [('fPixelRef', ctypes.c_void_p), ('fPixmap', SkPixmap), ('fFlags', ctypes.c_uint32)]

        self.get_file_content_size = get_file_content_size
        self.get_file_content = get_file_content
        self.SkBitmap = SkBitmap

        with suppress_output():
            self.screen_ai = ctypes.CDLL(os.path.join(self.model_dir, 'chrome_screen_ai.dll' if sys.platform == 'win32' else 'libchromescreenai.so'))
            self.screen_ai.SetFileContentFunctions.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            self.screen_ai.InitOCRUsingCallback.restype = ctypes.c_bool
            self.screen_ai.SetOCRLightMode.argtypes = [ctypes.c_bool]
            self.screen_ai.PerformOCR.argtypes = [ctypes.POINTER(self.SkBitmap), ctypes.POINTER(ctypes.c_uint32)]
            self.screen_ai.PerformOCR.restype = ctypes.c_void_p
            self.screen_ai.FreeLibraryAllocatedCharArray.argtypes = [ctypes.c_void_p]
            self.screen_ai.SetFileContentFunctions(self.get_file_content_size, self.get_file_content)
            self.screen_ai.InitOCRUsingCallback()
            self.screen_ai.SetOCRLightMode(False)
            time.sleep(0.5)

        self.available = True
        logger.info('Chrome Screen AI ready')

    def _rectangle_to_bounding_box(self, x1, y1, width, height, angle, img_width, img_height):
        angle_rad = radians(angle)
        cx_offset = (width / 2) * cos(angle_rad) - (height / 2) * sin(angle_rad)
        cy_offset = (width / 2) * sin(angle_rad) + (height / 2) * cos(angle_rad)
        center_x = x1 + cx_offset
        center_y = y1 + cy_offset

        return BoundingBox(
            center_x=center_x / img_width,
            center_y=center_y / img_height,
            width=width / img_width,
            height=height / img_height,
            rotation_z=angle_rad
        )

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        lines_by_block = {}
        directions_by_block = {}
        for l in response.get('lines', []):
            block_id = l.get('block_id', 0)
            words = []
            for w in l.get('words', []):
                w_bbox = w.get('bounding_box', {})
                x1 = w_bbox.get('x', 0)
                y1 = w_bbox.get('y', 0)
                width = w_bbox.get('width', 0)
                height = w_bbox.get('height', 0)
                angle = w_bbox.get('angle', 0)

                word = Word(
                    text=w.get('utf8_string', ''),
                    bounding_box=self._rectangle_to_bounding_box(x1, y1, width, height, angle, img_width, img_height)
                )
                words.append(word)

            l_bbox = l.get('bounding_box', {})
            x1 = l_bbox.get('x', 0)
            y1 = l_bbox.get('y', 0)
            width = l_bbox.get('width', 0)
            height = l_bbox.get('height', 0)
            angle = l_bbox.get('angle', 0)
            l_bbox_normalized = self._rectangle_to_bounding_box(x1, y1, width, height, angle, img_width, img_height)

            line = Line(
                bounding_box=l_bbox_normalized,
                words=words,
                text=l.get('utf8_string', ''),
            )
            if block_id not in lines_by_block:
                lines_by_block[block_id] = []
            if block_id not in directions_by_block:
                directions_by_block[block_id] = l.get('direction', '')
            lines_by_block[block_id].append(line)

        paragraphs = []
        for block_id in sorted(lines_by_block.keys()):
            lines = lines_by_block[block_id]
            min_left = min(line.bounding_box.left for line in lines)
            max_right = max(line.bounding_box.right for line in lines)
            min_top = min(line.bounding_box.top for line in lines)
            max_bottom = max(line.bounding_box.bottom for line in lines)

            width = max_right - min_left
            height = max_bottom - min_top
            center_x = min_left + width / 2
            center_y = min_top + height / 2

            paragraph_bbox = BoundingBox(
                center_x=center_x,
                center_y=center_y,
                width=width,
                height=height
            )

            raw_direction = directions_by_block[block_id]
            writing_direction = raw_direction.replace('DIRECTION_', '') if raw_direction else None

            paragraph = Paragraph(
                bounding_box=paragraph_bbox,
                lines=lines,
                writing_direction=writing_direction
            )
            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_bytes, img_width, img_height = self._preprocess(img)

        bitmap = self.SkBitmap()
        bitmap.fPixmap.fPixels = ctypes.cast(ctypes.c_char_p(img_bytes), ctypes.c_void_p)
        bitmap.fPixmap.fRowBytes = img_width * 4
        bitmap.fPixmap.fInfo.fColorInfo.fColorType = 4
        bitmap.fPixmap.fInfo.fColorInfo.fAlphaType = 1
        bitmap.fPixmap.fInfo.fDimensions.fWidth = img_width
        bitmap.fPixmap.fInfo.fDimensions.fHeight = img_height

        with suppress_output():
            output_length = ctypes.c_uint32(0)
            result_ptr = self.screen_ai.PerformOCR(ctypes.byref(bitmap), ctypes.byref(output_length))

        if not result_ptr:
            return (False, 'Unknown error!')

        proto_bytes = ctypes.string_at(result_ptr, output_length.value)
        self.screen_ai.FreeLibraryAllocatedCharArray(result_ptr)
        response_proto = VisualAnnotation()
        response_proto.ParseFromString(proto_bytes)
        response_dict = MessageToDict(response_proto, preserving_proto_field_name=True)

        ocr_result = self._to_generic_result(response_dict, img_width, img_height, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        if img.width * img.height > 3000000:
            aspect_ratio = img.width / img.height
            new_w = int(sqrt(3000000 * aspect_ratio))
            new_h = int(new_w / aspect_ratio)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return img.convert('RGBA').tobytes(), img.width, img.height

class GoogleLens:
    name = 'glens'
    readable_name = 'Google Lens'
    key = 'l'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Google Lens')
        with GlobalImport():
            try:
                from google.protobuf.json_format import MessageToDict
                from .lens_protos.lens_overlay_server_pb2 import LensOverlayServerRequest, LensOverlayServerResponse
                from .lens_protos.lens_overlay_platform_pb2 import PLATFORM_WEB
                from .lens_protos.lens_overlay_surface_pb2 import SURFACE_CHROMIUM
                from .lens_protos.lens_overlay_filters_pb2 import AUTO_FILTER
                import random
            except ImportError:
                return False
            return True

    def __init__(self):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Google Lens will not work!')
        else:
            self.available = True
            logger.info('Google Lens ready')

    def _to_generic_result(self, response, img_width, img_height):
        paragraphs = []
        if 'objects_response' in response and 'text' in response['objects_response']:
            text_data = response['objects_response']['text']
            if 'text_layout' in text_data:
                for p in text_data['text_layout'].get('paragraphs', []):
                    lines = []
                    for l in p.get('lines', []):
                        words = []
                        for w in l.get('words', []):
                            w_bbox = w.get('geometry', {}).get('bounding_box', {})
                            word = Word(
                                text=w.get('plain_text', ''),
                                separator=w.get('text_separator'),
                                bounding_box=BoundingBox(
                                    center_x=w_bbox.get('center_x'),
                                    center_y=w_bbox.get('center_y'),
                                    width=w_bbox.get('width'),
                                    height=w_bbox.get('height'),
                                    rotation_z=w_bbox.get('rotation_z')
                                )
                            )
                            words.append(word)

                        l_bbox = l.get('geometry', {}).get('bounding_box', {})
                        line = Line(
                            bounding_box=BoundingBox(
                                center_x=l_bbox.get('center_x'),
                                center_y=l_bbox.get('center_y'),
                                width=l_bbox.get('width'),
                                height=l_bbox.get('height'),
                                rotation_z=l_bbox.get('rotation_z')
                            ),
                            words=words
                        )
                        lines.append(line)

                    p_bbox = p.get('geometry', {}).get('bounding_box', {})
                    writing_direction = p.get('writing_direction')
                    if writing_direction:
                        writing_direction = writing_direction.replace('WRITING_DIRECTION_', '')

                    paragraph = Paragraph(
                        bounding_box=BoundingBox(
                            center_x=p_bbox.get('center_x'),
                            center_y=p_bbox.get('center_y'),
                            width=p_bbox.get('width'),
                            height=p_bbox.get('height'),
                            rotation_z=p_bbox.get('rotation_z')
                        ),
                        lines=lines,
                        writing_direction=writing_direction
                    )
                    paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        request = LensOverlayServerRequest()

        request.objects_request.request_context.request_id.uuid = random.randint(0, 2**64 - 1)
        request.objects_request.request_context.request_id.sequence_id = 0
        request.objects_request.request_context.request_id.image_sequence_id = 0
        request.objects_request.request_context.request_id.analytics_id = random.randbytes(16)
        request.objects_request.request_context.request_id.routing_info.Clear()

        request.objects_request.request_context.client_context.platform = PLATFORM_WEB
        request.objects_request.request_context.client_context.surface = SURFACE_CHROMIUM

        request.objects_request.request_context.client_context.locale_context.language = 'ja'
        request.objects_request.request_context.client_context.locale_context.region = 'Asia/Tokyo'
        request.objects_request.request_context.client_context.locale_context.time_zone = '' # not set by chromium

        request.objects_request.request_context.client_context.app_id = '' # not set by chromium

        filter = request.objects_request.request_context.client_context.client_filters.filter.add()
        filter.filter_type = AUTO_FILTER

        img_bytes, img_width, img_height = self._preprocess(img)
        request.objects_request.image_data.payload.image_bytes = img_bytes
        request.objects_request.image_data.image_metadata.width = img_width
        request.objects_request.image_data.image_metadata.height = img_height

        payload = request.SerializeToString()

        headers = {
            'Host': 'lensfrontend-pa.googleapis.com',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-protobuf',
            'X-Goog-Api-Key': 'AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Dest': 'empty'
        }

        try:
            res = curl_cffi.post('https://lensfrontend-pa.googleapis.com/v1/crupload', data=payload, headers=headers, impersonate='chrome', timeout=20)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        response_proto = LensOverlayServerResponse()
        response_proto.ParseFromString(res.content)
        response_dict = MessageToDict(response_proto, preserving_proto_field_name=True)

        ocr_result = self._to_generic_result(response_dict, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        if img.width * img.height > 3000000:
            aspect_ratio = img.width / img.height
            new_w = int(sqrt(3000000 * aspect_ratio))
            new_h = int(new_w / aspect_ratio)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return pil_image_to_bytes(img), img.width, img.height

class Bing:
    name = 'bing'
    readable_name = 'Bing'
    key = 'b'
    config_entry = None
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True
    )

    def __init__(self):
        self.requests_session = curl_cffi.Session()
        self.available = True
        logger.info('Bing ready')

    def _convert_bbox(self, quad):
        return quad_to_bounding_box(
            quad['topLeft']['x'], quad['topLeft']['y'],
            quad['topRight']['x'], quad['topRight']['y'],
            quad['bottomRight']['x'], quad['bottomRight']['y'],
            quad['bottomLeft']['x'], quad['bottomLeft']['y']
        )

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        paragraphs = []
        text_tag = None
        for tag in response.get('tags', []):
            if tag.get('displayName') == '##TextRecognition':
                text_tag = tag
                break

        if text_tag:
            text_action = None
            for action in text_tag.get('actions', []):
                if action.get('_type') == 'ImageKnowledge/TextRecognitionAction':
                    text_action = action
                    break

            if text_action:
                for p in text_action.get('data', {}).get('regions', []):
                    lines = []
                    for l in p.get('lines', []):
                        words = []
                        for w in l.get('words', []):
                            word = Word(
                                text=w.get('text', ''),
                                bounding_box=self._convert_bbox(w['boundingBox'])
                            )
                            words.append(word)

                        line = Line(
                            text=l.get('text', ''),
                            bounding_box=self._convert_bbox(l['boundingBox']),
                            words=words
                        )
                        lines.append(line)

                    paragraph = Paragraph(
                        bounding_box=self._convert_bbox(p['boundingBox']),
                        lines=lines
                    )
                    paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        img_bytes, img_size = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        upload_url = 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload'
        upload_headers = {
            'origin': 'https://www.bing.com'
        }
        mp = curl_cffi.CurlMime()
        mp.addpart(name='imgurl', data='')
        mp.addpart(name='cbir', data='sbi')
        mp.addpart(name='imageBin', data=img_bytes)

        for _ in range(2):
            api_host = urlparse(upload_url).netloc
            try:
                res = self.requests_session.post(upload_url, headers=upload_headers, multipart=mp, allow_redirects=False, impersonate='chrome', timeout=20)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 302:
                return (False, 'Unknown error!')

            redirect_url = res.headers.get('Location')
            if not redirect_url:
                return (False, 'Error getting redirect URL!')
            if not redirect_url.startswith('https://'):
                break
            upload_url = redirect_url

        parsed_url = urlparse(redirect_url)
        query_params = parse_qs(parsed_url.query)

        image_insights_token = query_params.get('insightsToken')
        if not image_insights_token:
            return (False, 'Error getting token!')
        image_insights_token = image_insights_token[0]

        api_url = f'https://{api_host}/images/api/custom/knowledge'
        api_headers = {
            'origin': 'https://www.bing.com',
            'referer': f'https://www.bing.com/images/search?view=detailV2&insightstoken={image_insights_token}'
        }
        api_data_json = {
            'imageInfo': {'imageInsightsToken': image_insights_token, 'source': 'Url'},
            'knowledgeRequest': {'invokedSkills': ['OCR'], 'index': 1}
        }
        mp2 = curl_cffi.CurlMime()
        mp2.addpart(name='knowledgeRequest', content_type='application/json', data=json.dumps(api_data_json))

        try:
            res = self.requests_session.post(api_url, headers=api_headers, multipart=mp2, impersonate='chrome', timeout=20)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        data = res.json()

        img_width, img_height = img_size
        ocr_result = self._to_generic_result(data, img_width, img_height, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        min_pixel_size = 50
        max_pixel_size = 4000
        max_byte_size = 767772
        res = None

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(min_pixel_size / img.width, min_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        img_bytes, _, img_size = limit_image_size(img, max_byte_size)

        if img_bytes:
            res = base64.b64encode(img_bytes).decode('utf-8')

        return res, img_size

class AppleVision:
    name = 'avision'
    readable_name = 'Apple Vision'
    key = 'a'
    config_entry = 'avision'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Apple Vision')
        with GlobalImport():
            import Vision

    def __init__(self, language='ja', config={}):
        if sys.platform != 'darwin':
            return
        elif int(platform.mac_ver()[0].split('.')[0]) < 13:
            logger.warning('Apple Vision is not supported on macOS older than Ventura/13.0!')
        else:
            self._import_dependencies()
            self.recognition_level = Vision.VNRequestTextRecognitionLevelFast if config.get('fast_mode', False) else Vision.VNRequestTextRecognitionLevelAccurate
            self.language_correction = config.get('language_correction', True)
            self.available = True
            self.language = [language, 'en']
            logger.info('Apple Vision ready')

    def _to_generic_result(self, response, img_width, img_height):
        lines = []
        for l in response:
            bbox_raw = l.boundingBox()
            bbox = BoundingBox(
                width=bbox_raw.size.width,
                height=bbox_raw.size.height,
                center_x=bbox_raw.origin.x + (bbox_raw.size.width / 2),
                center_y=(1 - bbox_raw.origin.y - bbox_raw.size.height / 2)
            )

            word = Word(
                text=l.text(),
                bounding_box=bbox
            )
            words = [word]

            line = Line(
                text=l.text(),
                bounding_box=bbox,
                words=words
            )

            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        with objc.autorelease_pool():
            req = Vision.VNRecognizeTextRequest.alloc().init()

            req.setRevision_(Vision.VNRecognizeTextRequestRevision3)
            req.setRecognitionLevel_(self.recognition_level)
            req.setUsesLanguageCorrection_(self.language_correction)
            req.setRecognitionLanguages_(self.language)

            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(
                self._preprocess(img), None
            )

            success = handler.performRequests_error_([req], None)
            res = []
            if success[0]:
                ocr_result = self._to_generic_result(req.results(), img.width, img.height)
                x = (True, ocr_result)
            else:
                x = (False, 'Unknown error!')

            if is_path:
                img.close()
            return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, 'tiff')

class AppleLiveText:
    name = 'alivetext'
    readable_name = 'Apple Live Text'
    key = 'd'
    config_entry = None
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = False
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Apple Live Text')
        with GlobalImport():
            import objc
            from AppKit import NSData, NSImage, NSBundle
            from CoreFoundation import CFRunLoopRunInMode, kCFRunLoopDefaultMode, CFRunLoopStop, CFRunLoopGetCurrent

    def __init__(self, language='ja'):
        if sys.platform != 'darwin':
            return
        elif int(platform.mac_ver()[0].split('.')[0]) < 13:
            logger.warning('Apple Live Text is not supported on macOS older than Ventura/13.0!')
        else:
            self._import_dependencies()
            app_info = NSBundle.mainBundle().infoDictionary()
            app_info['LSBackgroundOnly'] = '1'
            self.VKCImageAnalyzer = objc.lookUpClass('VKCImageAnalyzer')
            self.VKCImageAnalyzerRequest = objc.lookUpClass('VKCImageAnalyzerRequest')
            objc.registerMetaDataForSelector(
                b'VKCImageAnalyzer',
                b'processRequest:progressHandler:completionHandler:',
                {
                    'arguments': {
                        3: {
                            'callable': {
                                'retval': {'type': b'v'},
                                'arguments': {
                                    0: {'type': b'^v'},
                                    1: {'type': b'd'},
                                }
                            }
                        },
                        4: {
                            'callable': {
                                'retval': {'type': b'v'},
                                'arguments': {
                                    0: {'type': b'^v'},
                                    1: {'type': b'@'},
                                    2: {'type': b'@'},
                                }
                            }
                        }
                    }
                }
            )
            self.language = [language, 'en']
            self.available = True
            logger.info('Apple Live Text ready')

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        self.result = None

        with objc.autorelease_pool():
            analyzer = self.VKCImageAnalyzer.alloc().init()
            req = self.VKCImageAnalyzerRequest.alloc().initWithImage_requestType_(self._preprocess(img), 1) #VKAnalysisTypeText
            req.setLocales_(self.language)
            analyzer.processRequest_progressHandler_completionHandler_(req, lambda progress: None, self._process)

            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 10.0, False)

        if self.result == None:
            return (False, 'Unknown error!')

        ocr_result = OcrResult(
            image_properties=ImageProperties(width=img.width, height=img.height),
            paragraphs=self.result,
            engine_capabilities=self.capabilities
        )
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _process(self, analysis, error):
        lines = []
        response_lines = analysis.allLines()
        if response_lines:
            for l in response_lines:
                words = []
                for i, w in enumerate(l.children()):
                    w_bbox = w.quad().boundingBox()
                    word = Word(
                        text=w.string(),
                        bounding_box=BoundingBox(
                            width=w_bbox.size.width,
                            height=w_bbox.size.height,
                            center_x=w_bbox.origin.x + (w_bbox.size.width / 2),
                            center_y=w_bbox.origin.y + (w_bbox.size.height / 2)
                        )
                    )
                    words.append(word)

                l_bbox = l.quad().boundingBox()
                line = Line(
                    text=l.string(),
                    bounding_box=BoundingBox(
                        width=l_bbox.size.width,
                        height=l_bbox.size.height,
                        center_x=l_bbox.origin.x + (l_bbox.size.width / 2),
                        center_y=l_bbox.origin.y + (l_bbox.size.height / 2)
                    ),
                    words=words
                )
                lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        self.result = paragraphs
        CFRunLoopStop(CFRunLoopGetCurrent())

    def _preprocess(self, img):
        image_bytes = pil_image_to_bytes(img, 'tiff')
        ns_data = NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
        ns_image = NSImage.alloc().initWithData_(ns_data)
        return ns_image

class WinRTOCR:
    name = 'winrtocr'
    readable_name = 'WinRT OCR'
    key = 'w'
    config_entry = 'winrtocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for WinRT OCR')
        with GlobalImport():
            try:
                import winocrfix
            except ImportError:
                return False
        return True

    def __init__(self, config={}, language='ja'):
        if sys.platform == 'win32':
            if int(platform.release()) < 10:
                logger.warning('WinRT OCR is not supported on Windows older than 10!')
                return
            dependencies_available = self._import_dependencies()
            if not dependencies_available:
                logger.warning('Dependencies not available, WinRT OCR will not work!')
            else:
                self.language = language
                self.available = True
                logger.info('WinRT OCR ready')
        else:
            try:
                self.url = config['url']
                self.language = language
                self.available = True
                logger.info('WinRT OCR ready')
            except:
                logger.warning('Error reading URL from config, WinRT OCR will not work!')

    def _normalize_bbox(self, rect, img_width, img_height):
        x_norm = rect['x'] / img_width
        y_norm = rect['y'] / img_height
        width_norm = rect['width'] / img_width
        height_norm = rect['height'] / img_height

        # Calculate center coordinates
        center_x = x_norm + (width_norm / 2)
        center_y = y_norm + (height_norm / 2)

        return BoundingBox(
            center_x=center_x,
            center_y=center_y,
            width=width_norm,
            height=height_norm
        )

    def _to_generic_result(self, response, img_width, img_height):
        lines = []
        for l in response.get('lines', []):
            words = []
            for i, w in enumerate(l.get('words', [])):
                word = Word(
                    text=w.get('text', ''),
                    bounding_box=self._normalize_bbox(w['bounding_rect'], img_width, img_height)
                )
                words.append(word)

            l_bbox = merge_bounding_boxes(words)
            line = Line(
                text=l.get('text', ''),
                bounding_box=l_bbox,
                words=words
            )
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        if sys.platform == 'win32':
            res = winocrfix.recognize_pil_sync(img, lang=self.language)
        else:
            params = {'lang': self.language}
            try:
                res = curl_cffi.post(self.url, params=params, data=self._preprocess(img), timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            res = res.json()

        ocr_result = self._to_generic_result(res, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_bytes(img, png_compression=1)

class OneOCR:
    name = 'oneocr'
    readable_name = 'OneOCR'
    key = 'z'
    config_entry = 'oneocr'
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for OneOCR')
        with GlobalImport():
            try:
                import oneocr
                import subprocess
                import shutil
            except ImportError:
                return False
        return True

    def __init__(self, config={}):
        if sys.platform == 'win32':
            if int(platform.release()) < 10:
                logger.warning('OneOCR is not supported on Windows older than 10!')
                return

            dependencies_available = self._import_dependencies()
            if not dependencies_available:
                logger.warning('Dependencies not available, OneOCR will not work!')
            else:
                if self._copy_files_if_needed():
                    try:
                        self.model = oneocr.OcrEngine()
                    except RuntimeError as e:
                        logger.warning(str(e) + ', OneOCR will not work!')
                    else:
                        self.available = True
                        logger.info('OneOCR ready')
        else:
            try:
                self.url = config['url']
                self.available = True
                logger.info('OneOCR ready')
            except:
                logger.warning('Error reading URL from config, OneOCR will not work!')

    def _copy_files_if_needed(self):
        target_path = os.path.join(os.path.expanduser('~'), '.config', 'oneocr')
        files_to_copy = ['oneocr.dll', 'oneocr.onemodel', 'onnxruntime.dll']
        copy_needed = False

        for filename in files_to_copy:
            file_target_path = os.path.join(target_path, filename)
            if not os.path.exists(file_target_path):
                copy_needed = True

        if not copy_needed:
            return True

        if int(platform.release()) < 11:
            logger.warning(f'Unable to find OneOCR files in {target_path}, OneOCR will not work!')
            return False

        logger.info(f'Copying OneOCR files to {target_path}')

        cmd = ['powershell', '-Command', 'Get-AppxPackage Microsoft.ScreenSketch | Select-Object -ExpandProperty InstallLocation']
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, shell=True, check=True)
            snipping_path = result.stdout.strip()
        except:
            snipping_path = None

        if not snipping_path:
            logger.warning('Error getting Snipping Tool folder, OneOCR will not work!')
            return False

        source_path = os.path.join(snipping_path, 'SnippingTool')
        if not os.path.exists(source_path):
            logger.warning('Error getting OneOCR SnippingTool folder, OneOCR will not work!')
            return False

        os.makedirs(target_path, exist_ok=True)

        for filename in files_to_copy:
            file_source_path = os.path.join(source_path, filename)
            file_target_path = os.path.join(target_path, filename)

            if os.path.exists(file_source_path):
                try:
                    shutil.copy2(file_source_path, file_target_path)
                except Exception as e:
                    logger.warning(f'Error copying {file_source_path}: {e}, OneOCR will not work!')
                    return False
            else:
                logger.warning(f'File not found {file_source_path}, OneOCR will not work!')
                return False
        return True

    def _convert_bbox(self, rect, img_width, img_height):
        return quad_to_bounding_box(
            rect['x1'], rect['y1'],
            rect['x2'], rect['y2'],
            rect['x3'], rect['y3'],
            rect['x4'], rect['y4'],
            img_width, img_height
        )

    def _to_generic_result(self, response, img_width, img_height, og_img_width, og_img_height):
        lines = []
        for l in response.get('lines', []):
            words = []
            for i, w in enumerate(l.get('words', [])):
                word = Word(
                    text=w.get('text', ''),
                    bounding_box=self._convert_bbox(w['bounding_rect'], img_width, img_height)
                )
                words.append(word)

            line = Line(
                text=l.get('text', ''),
                bounding_box=self._convert_bbox(l['bounding_rect'], img_width, img_height),
                words=words
            )
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        if sys.platform == 'win32':
            img_processed = self._preprocess_windows(img)
            img_width, img_height = img_processed.size
            try:
                raw_res = self.model.recognize_pil(img_processed)
            except RuntimeError as e:
                return (False, str(e))
        else:
            img_processed, img_width, img_height = self._preprocess_notwindows(img)
            try:
                res = curl_cffi.post(self.url, data=img_processed, timeout=3)
            except curl_cffi.requests.exceptions.Timeout:
                return (False, 'Request timeout!')
            except curl_cffi.requests.exceptions.ConnectionError:
                return (False, 'Connection error!')

            if res.status_code != 200:
                return (False, 'Unknown error!')

            raw_res = res.json()

        if 'error' in raw_res:
            return (False, raw_res['error'])

        ocr_result = self._to_generic_result(raw_res, img_width, img_height, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess_windows(self, img):
        min_pixel_size = 50
        max_pixel_size = 10000

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(min_pixel_size / img.width, min_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return img

    def _preprocess_notwindows(self, img):
        img = self._preprocess_windows(img)
        return pil_image_to_bytes(img, png_compression=1), img.width, img.height

class AzureImageAnalysis:
    name = 'azure'
    readable_name = 'Azure Image Analysis'
    key = 'v'
    config_entry = 'azure'
    available = False
    local = False
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for Azure Image Analysis')
        with GlobalImport():
            try:
                from azure.ai.vision.imageanalysis import ImageAnalysisClient
                from azure.ai.vision.imageanalysis.models import VisualFeatures
                from azure.core.credentials import AzureKeyCredential
                from azure.core.exceptions import ServiceRequestError
            except ImportError:
                return False
        return True

    def __init__(self, config={}):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, Azure Image Analysis will not work!')
        else:
            logger.info(f'Parsing Azure credentials')
            try:
                self.client = ImageAnalysisClient(config['endpoint'], AzureKeyCredential(config['api_key']))
                self.available = True
                logger.info('Azure Image Analysis ready')
            except:
                logger.warning('Error parsing Azure credentials, Azure Image Analysis will not work!')

    def _convert_bbox(self, rect, img_width, img_height):
        return quad_to_bounding_box(
            rect[0]['x'], rect[0]['y'],
            rect[1]['x'], rect[1]['y'],
            rect[2]['x'], rect[2]['y'],
            rect[3]['x'], rect[3]['y'],
            img_width, img_height
        )

    def _to_generic_result(self, read_result, img_width, img_height):
        paragraphs = []
        if read_result.read:
            for block in read_result.read.blocks:
                lines = []
                for azure_line in block.lines:
                    l_bbox = self._convert_bbox(azure_line.bounding_polygon, img_width, img_height)

                    words = []
                    for azure_word in azure_line.words:
                        w_bbox = self._convert_bbox(azure_word.bounding_polygon, img_width, img_height)
                        word = Word(
                            text=azure_word.text,
                            bounding_box=w_bbox
                        )
                        words.append(word)

                    line = Line(
                        bounding_box=l_bbox,
                        words=words,
                        text=azure_line.text
                    )
                    lines.append(line)

                p_bbox = merge_bounding_boxes(lines)
                paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
                paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        try:
            read_result = self.client.analyze(image_data=self._preprocess(img), visual_features=[VisualFeatures.READ])
        except ServiceRequestError:
            return (False, 'Connection error!')
        except:
            return (False, 'Unknown error!')

        ocr_result = self._to_generic_result(read_result, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        min_pixel_size = 50
        max_pixel_size = 10000

        if any(x < min_pixel_size for x in img.size):
            resize_factor = max(min_pixel_size / img.width, min_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        if any(x > max_pixel_size for x in img.size):
            resize_factor = min(max_pixel_size / img.width, max_pixel_size / img.height)
            new_w = int(img.width * resize_factor)
            new_h = int(img.height * resize_factor)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        return pil_image_to_bytes(img)

class EasyOCR:
    name = 'easyocr'
    readable_name = 'EasyOCR'
    key = 'e'
    config_entry = 'easyocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for EasyOCR')
        with GlobalImport():
            try:
                import easyocr
            except ImportError:
                return False
        return True

    def __init__(self, config={}, language='ja'):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, EasyOCR will not work!')
        else:
            logger.info('Loading EasyOCR model')
            gpu = config.get('gpu', True)
            logging.getLogger('easyocr.easyocr').setLevel(logging.ERROR)
            self.model = easyocr.Reader([language,'en'], gpu=gpu)
            self.available = True
            logger.info('EasyOCR ready')

    def _convert_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height):
        lines = []

        for detection in response:
            quad_coords = detection[0]
            text = detection[1]

            bbox = self._convert_bbox(quad_coords, img_width, img_height)
            word = Word(text=text, bounding_box=bbox)
            line = Line(bounding_box=bbox, words=[word], text=text)
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        read_results = self.model.readtext(self._preprocess(img))
        ocr_result = self._to_generic_result(read_results, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class RapidOCR:
    name = 'rapidocr'
    readable_name = 'RapidOCR'
    key = 'r'
    config_entry = 'rapidocr'
    available = False
    local = True
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=False,
        word_bounding_boxes=False,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for RapidOCR')
        with GlobalImport():
            try:
                from rapidocr import RapidOCR as ROCR
                from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion
            except ImportError:
                return False
        return True

    def __init__(self, config={}, language='ja'):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, RapidOCR will not work!')
        else:
            logger.info('Loading RapidOCR model')
            high_accuracy_detection = config.get('high_accuracy_detection', False)
            high_accuracy_recognition = config.get('high_accuracy_recognition', True)
            lang_rec = self.language_to_model_language(language)
            self.model = ROCR(params={
                'Det.engine_type': EngineType.ONNXRUNTIME,
                'Det.lang_type': LangDet.CH,
                'Det.model_type': ModelType.SERVER if high_accuracy_detection else ModelType.MOBILE,
                'Det.ocr_version': OCRVersion.PPOCRV5,
                'Rec.engine_type': EngineType.ONNXRUNTIME,
                'Rec.lang_type': lang_rec,
                'Rec.model_type': ModelType.SERVER if high_accuracy_recognition else ModelType.MOBILE,
                'Rec.ocr_version': OCRVersion.PPOCRV5,
                'Global.log_level': 'error'
            })
            self.available = True
            logger.info('RapidOCR ready')

    def language_to_model_language(self, language):
        if language == 'ja':
            return LangRec.CH
        if language == 'zh':
            return LangRec.CH
        elif language == 'ko':
            return LangRec.KOREAN
        elif language == 'ru':
            return LangRec.ESLAV
        elif language == 'el':
            return LangRec.EL
        elif language == 'th':
            return LangRec.TH
        else:
            return LangRec.LATIN

    def _convert_bbox(self, rect, img_width, img_height):
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = [(float(x), float(y)) for x, y in rect]
        return quad_to_bounding_box(x1, y1, x2, y2, x3, y3, x4, y4, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height):
        lines = []

        for i in range(len(response.boxes)):
            box = response.boxes[i]
            text = response.txts[i]
            bbox = self._convert_bbox(box, img_width, img_height)
            word = Word(text=text, bounding_box=bbox)
            line = Line(bounding_box=bbox, words=[word], text=text)
            lines.append(line)

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        read_results = self.model(self._preprocess(img))
        ocr_result = self._to_generic_result(read_results, img.width, img.height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return pil_image_to_numpy_array(img)

class MeikiOCR:
    name = 'meikiocr'
    readable_name = 'meikiocr'
    key = 'k'
    config_entry = None
    available = False
    local = True
    manual_language = False
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def _import_dependencies(self):
        logger.info('Loading dependencies for meikiocr')
        with GlobalImport():
            try:
                from meikiocr import MeikiOCR as MKOCR
            except ImportError:
                return False
        return True

    def __init__(self):
        dependencies_available = self._import_dependencies()

        if not dependencies_available:
            logger.warning('Dependencies not available, meikiocr will not work!')
        else:
            logger.info('Loading meikiocr model')
            self.model = MKOCR()
            self.available = True
            logger.info('meikiocr ready')

    def _to_normalized_bbox(self, rect, img_width, img_height):
        x1, y1, x2, y2 = rect
        return rectangle_to_bounding_box(x1, y1, x2, y2, img_width, img_height)

    def _to_generic_result(self, response, img_width, img_height):
        paragraphs = []

        # each dictionary in the response corresponds to a detected line of text.
        # treat each line as a separate Paragraph containing a single Line.
        for line_result in response:
            line_text = line_result.get('text', '')
            char_results = line_result.get('chars', [])
            if not line_text or not char_results:
                continue

            char_in_line = []
            for char_info in char_results:
                normalized_bbox = self._to_normalized_bbox(
                    char_info['bbox'], img_width, img_height
                )
                word = Word(
                    text=char_info['char'],
                    bounding_box=normalized_bbox
                )
                char_in_line.append(word)

            if not char_in_line:
                continue

            line_bbox = merge_bounding_boxes(char_in_line)

            line = Line(
                bounding_box=line_bbox,
                words=char_in_line,
                text=line_text
            )

            # each line becomes a paragraph.
            paragraph = Paragraph(
                bounding_box=line_bbox,
                lines=[line],
                writing_direction="LEFT_TO_RIGHT" # meikiocr only supports horizontal text
            )
            paragraphs.append(paragraph)

        return OcrResult(
            image_properties=ImageProperties(width=img_width, height=img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        image_np = np.array(img.convert('RGB'))

        read_results = self.model.run_ocr(image_np, punct_conf_factor=0.2)
        ocr_result = self._to_generic_result(read_results, img.width, img.height)

        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

class OCRSpace:
    name = 'ocrspace'
    readable_name = 'OCRSpace'
    key = 'o'
    config_entry = 'ocrspace'
    available = False
    local = False
    manual_language = True
    coordinate_support = True
    threading_support = True
    capabilities = EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=False,
        paragraphs=False,
        paragraph_bounding_boxes=False
    )

    def __init__(self, config={}, language='ja'):
        try:
            self.api_key = config['api_key']
            self.max_byte_size = config.get('file_size_limit', 1000000)
            self.engine_version = config.get('engine_version', 2)
            self.language = self.language_to_model_language(language)
            self.available = True
            logger.info('OCRSpace ready')
        except:
            logger.warning('Error reading API key from config, OCRSpace will not work!')

    def language_to_model_language(self, language):
        if language == 'ja':
            return 'jpn'
        if language == 'zh':
            return 'chs'
        elif language == 'ko':
            return 'kor'
        elif language == 'ar':
            return 'ara'
        elif language == 'ru':
            return 'rus'
        elif language == 'el':
            return 'gre'
        elif language == 'th':
            return 'tha'
        else:
            return 'auto'

    def _convert_bbox(self, word_data, img_width, img_height):
        left = word_data['Left'] / img_width
        top = word_data['Top'] / img_height
        width = word_data['Width'] / img_width
        height = word_data['Height'] / img_height

        center_x = left + width / 2
        center_y = top + height / 2

        return BoundingBox(
            center_x=center_x,
            center_y=center_y,
            width=width,
            height=height
        )

    def _to_generic_result(self, api_result, img_width, img_height, og_img_width, og_img_height):
        parsed_result = api_result['ParsedResults'][0]
        text_overlay = parsed_result.get('TextOverlay', {})
        lines_data = text_overlay.get('Lines', [])

        lines = []
        for line_data in lines_data:
            words = []
            for word_data in line_data.get('Words', []):
                w_bbox = self._convert_bbox(word_data, img_width, img_height)
                words.append(Word(text=word_data['WordText'], bounding_box=w_bbox))

            l_bbox = merge_bounding_boxes(words)
            lines.append(Line(bounding_box=l_bbox, words=words))

        if lines:
            p_bbox = merge_bounding_boxes(lines)
            paragraph = Paragraph(bounding_box=p_bbox, lines=lines)
            paragraphs = [paragraph]
        else:
            paragraphs = []

        return OcrResult(
            image_properties=ImageProperties(width=og_img_width, height=og_img_height),
            paragraphs=paragraphs,
            engine_capabilities=self.capabilities
        )

    def __call__(self, img):
        img, is_path = input_to_pil_image(img)
        if not img:
            return (False, 'Invalid image provided')

        og_img_width, og_img_height = img.size
        img_bytes, img_extension, img_size = self._preprocess(img)
        if not img_bytes:
            return (False, 'Image is too big!')

        data = {
            'apikey': self.api_key,
            'language': self.language,
            'OCREngine': str(self.engine_version),
            'isOverlayRequired': 'True'
        }
        mp = curl_cffi.CurlMime()
        mp.addpart(name='file', filename=f'image.{img_extension}', content_type=f'image/{img_extension}', data=img_bytes)

        try:
            res = curl_cffi.post('https://api.ocr.space/parse/image', data=data, multipart=mp, timeout=20)
        except curl_cffi.requests.exceptions.Timeout:
            return (False, 'Request timeout!')
        except curl_cffi.requests.exceptions.ConnectionError:
            return (False, 'Connection error!')

        if res.status_code != 200:
            return (False, 'Unknown error!')

        res = res.json()

        if isinstance(res, str):
            return (False, 'Unknown error!')
        if res['IsErroredOnProcessing']:
            return (False, res['ErrorMessage'])

        img_width, img_height = img_size
        ocr_result = self._to_generic_result(res, img_width, img_height, og_img_width, og_img_height)
        x = (True, ocr_result)

        if is_path:
            img.close()
        return x

    def _preprocess(self, img):
        return limit_image_size(img, self.max_byte_size)
