"""
Image processing utilities for API clients.

Common image handling functionality used by both VNDB and AniList API clients,
including fetching, resizing, format conversion, and base64 encoding.
"""

import base64
import io
import requests
from PIL import Image
from typing import Optional, Tuple

from GameSentenceMiner.util.config.configuration import logger

# Standard sizes for different image types
THUMBNAIL_SIZE = (80, 100)
COVER_IMAGE_SIZE = (300, 400)


def convert_image_to_rgb(image: Image.Image) -> Image.Image:
    """
    Convert an image to RGB format, handling transparency and palette modes.
    
    This function handles various image modes (RGBA, P, LA, etc.) by creating
    a white background and compositing the image onto it. This ensures consistent
    RGB output suitable for JPEG encoding.
    
    Args:
        image: PIL Image object in any mode
        
    Returns:
        PIL Image object in RGB mode
        
    Example:
        >>> from PIL import Image
        >>> png_image = Image.open("transparent.png")  # RGBA mode
        >>> rgb_image = convert_image_to_rgb(png_image)
        >>> assert rgb_image.mode == "RGB"
    """
    # Already RGB, return as-is
    if image.mode == 'RGB':
        return image
    
    # Handle images with transparency or palette mode
    if image.mode in ('RGBA', 'P', 'LA'):
        # Create white background
        background = Image.new('RGB', image.size, (255, 255, 255))
        
        # Convert palette mode to RGBA first
        if image.mode == 'P':
            image = image.convert('RGBA')
        
        # Composite image onto white background using alpha channel
        if image.mode in ('RGBA', 'LA'):
            background.paste(image, mask=image.split()[-1])
        else:
            background.paste(image)
        
        return background
    
    # For any other mode, convert directly to RGB
    return image.convert('RGB')


def resize_image_if_needed(
    image_data: bytes,
    max_width: int,
    max_height: int
) -> bytes:
    """
    Resize image if it exceeds maximum dimensions.
    
    Uses high-quality Lanczos resampling to maintain image quality while
    reducing size. The aspect ratio is preserved using thumbnail mode.
    
    Args:
        image_data: Raw image bytes
        max_width: Maximum width in pixels
        max_height: Maximum height in pixels
        
    Returns:
        Resized image as bytes (same format as input)
        
    Raises:
        PIL.UnidentifiedImageError: If image_data cannot be opened as an image
        
    Example:
        >>> with open("large_image.jpg", "rb") as f:
        ...     data = f.read()
        >>> resized = resize_image_if_needed(data, 800, 600)
        >>> # Image is now at most 800x600 pixels
    """
    image = Image.open(io.BytesIO(image_data))
    
    # Check if resize is needed
    if image.width <= max_width and image.height <= max_height:
        return image_data
    
    # Resize using high-quality resampling
    image.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    
    # Save back to bytes
    buffer = io.BytesIO()
    
    # Preserve original format if possible
    image_format = image.format or 'PNG'
    image.save(buffer, format=image_format, optimize=True)
    buffer.seek(0)
    
    return buffer.getvalue()


def fetch_image_as_base64(
    image_url: str,
    thumbnail_size: Tuple[int, int] = THUMBNAIL_SIZE,
    timeout: int = 10,
    output_format: str = 'JPEG',
    jpeg_quality: int = 85
) -> Optional[str]:
    """
    Download an image from URL, resize to thumbnail, and convert to base64 string.
    
    This is the primary function for fetching character images and other small
    images from API sources. It handles format conversion, resizing, and encoding
    in a single operation.
    
    Args:
        image_url: URL of the image to download
        thumbnail_size: Tuple of (width, height) for thumbnail. Defaults to (80, 100)
        timeout: Request timeout in seconds (default: 10)
        output_format: Output image format - 'JPEG' or 'PNG' (default: 'JPEG')
        jpeg_quality: JPEG quality 0-100 (default: 85, only used if format is JPEG)
        
    Returns:
        Base64-encoded image string with data URI prefix (e.g., 
        "data:image/jpeg;base64,/9j/4AAQ..."), or None on failure
        
    Example:
        >>> url = "https://example.com/character.png"
        >>> base64_str = fetch_image_as_base64(url)
        >>> if base64_str:
        ...     # Use in HTML: <img src="{base64_str}" />
        ...     pass
    """
    if not image_url:
        return None
    
    try:
        response = requests.get(image_url, timeout=timeout)
        if response.status_code != 200:
            logger.debug(f"Failed to fetch image from {image_url}: status {response.status_code}")
            return None
        
        # Open image with PIL
        image = Image.open(io.BytesIO(response.content))
        
        # Convert to RGB if necessary (handles RGBA, P mode, etc.)
        image = convert_image_to_rgb(image)
        
        # Resize to thumbnail using high-quality resampling
        image.thumbnail(thumbnail_size, Image.Resampling.LANCZOS)
        
        # Save to bytes buffer
        buffer = io.BytesIO()
        
        if output_format.upper() == 'JPEG':
            image.save(buffer, format='JPEG', quality=jpeg_quality, optimize=True)
            mime_type = 'image/jpeg'
        elif output_format.upper() == 'PNG':
            image.save(buffer, format='PNG', optimize=True)
            mime_type = 'image/png'
        else:
            logger.warning(f"Unsupported output format: {output_format}, using JPEG")
            image.save(buffer, format='JPEG', quality=jpeg_quality, optimize=True)
            mime_type = 'image/jpeg'
        
        buffer.seek(0)
        
        # Encode to base64
        image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"data:{mime_type};base64,{image_base64}"
    
    except requests.RequestException as e:
        logger.debug(f"Failed to download image from {image_url}: {e}")
        return None
    except Exception as e:
        logger.debug(f"Unexpected error converting image to base64: {e}")
        return None


def download_cover_image(
    image_url: str,
    cover_size: Tuple[int, int] = COVER_IMAGE_SIZE,
    timeout: int = 10,
    output_format: str = 'PNG'
) -> Optional[str]:
    """
    Download and process a cover image from a URL.
    
    This function is specifically designed for larger cover images (game covers,
    anime/manga covers) as opposed to small character thumbnails. It uses PNG
    format by default for better quality.
    
    Args:
        image_url: Direct URL to the cover image
        cover_size: Tuple of (width, height) for cover. Defaults to (300, 400)
        timeout: Request timeout in seconds (default: 10)
        output_format: Output format - 'PNG' or 'JPEG' (default: 'PNG')
        
    Returns:
        Base64-encoded image string with data URI prefix, or None on failure
        
    Example:
        >>> cover_url = "https://cdn.vndb.org/cv/12/34567.jpg"
        >>> base64_cover = download_cover_image(cover_url)
        >>> # Returns data:image/png;base64,iVBORw0KG...
    """
    if not image_url:
        logger.debug("No image URL provided for cover download")
        return None
    
    try:
        logger.debug(f"Downloading cover image from {image_url}")
        img_response = requests.get(image_url, timeout=timeout)
        
        if img_response.status_code != 200:
            logger.debug(f"Failed to download cover image: status {img_response.status_code}")
            return None
        
        # Open and process the image
        image = Image.open(io.BytesIO(img_response.content))
        
        # Convert to RGB if necessary
        image = convert_image_to_rgb(image)
        
        # Resize to cover size
        image.thumbnail(cover_size, Image.Resampling.LANCZOS)
        
        # Save to buffer
        buffer = io.BytesIO()
        
        if output_format.upper() == 'PNG':
            image.save(buffer, format='PNG', optimize=True)
            mime_type = 'image/png'
        elif output_format.upper() == 'JPEG':
            image.save(buffer, format='JPEG', quality=90, optimize=True)
            mime_type = 'image/jpeg'
        else:
            logger.warning(f"Unsupported format: {output_format}, using PNG")
            image.save(buffer, format='PNG', optimize=True)
            mime_type = 'image/png'
        
        buffer.seek(0)
        
        image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        logger.success(f"Downloaded and processed cover image")
        return f"data:{mime_type};base64,{image_base64}"
    
    except requests.RequestException as e:
        logger.debug(f"Failed to fetch cover image: {e}")
        return None
    except Exception as e:
        logger.debug(f"Unexpected error downloading cover image: {e}")
        return None
