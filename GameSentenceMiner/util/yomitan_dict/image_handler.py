"""Image handling for Yomitan dictionary creation."""

import base64
from typing import Tuple


class ImageHandler:
    """
    Handles image processing for Yomitan dictionaries.
    
    This class manages:
    - Decoding base64-encoded images
    - Determining image format from data URI
    - Creating image filenames for ZIP storage
    """
    
    def decode_image(self, base64_data: str, char_id: str) -> Tuple[str, bytes]:
        """
        Decode a base64-encoded image.
        
        Args:
            base64_data: Base64 string, may include data URI prefix
            char_id: Character ID for generating filename
            
        Returns:
            Tuple of (filename, image_bytes)
        """
        # Strip "data:image/jpeg;base64," or similar prefix if present
        if ',' in base64_data:
            # Handle data URI format: "data:image/jpeg;base64,..."
            header, base64_data = base64_data.split(',', 1)
            # Determine extension from header
            if 'png' in header.lower():
                ext = 'png'
            elif 'gif' in header.lower():
                ext = 'gif'
            elif 'webp' in header.lower():
                ext = 'webp'
            else:
                ext = 'jpg'  # Default to jpg
        else:
            ext = 'jpg'  # Default extension
        
        # Decode base64 to bytes
        image_bytes = base64.b64decode(base64_data)
        filename = f"c{char_id}.{ext}"
        
        return filename, image_bytes
    
    def create_image_content(self, image_path: str) -> dict:
        """
        Create Yomitan structured content for an image.
        
        Args:
            image_path: Path to image within ZIP (e.g., "img/c12345.jpg")
            
        Returns:
            Yomitan image content dictionary
        """
        return {
            "tag": "img",
            "path": image_path,
            "width": 80,
            "height": 100,
            "sizeUnits": "px",
            "collapsible": False,
            "collapsed": False,
            "background": False
        }
    
    def validate_image(self, base64_data: str) -> bool:
        """
        Validate that a base64 string represents a valid image.
        
        Args:
            base64_data: Base64 string to validate
            
        Returns:
            True if valid, False otherwise
        """
        if not base64_data:
            return False
        
        try:
            # Try to decode the base64
            if ',' in base64_data:
                _, actual_data = base64_data.split(',', 1)
            else:
                actual_data = base64_data
            
            base64.b64decode(actual_data)
            return True
        except Exception:
            return False
