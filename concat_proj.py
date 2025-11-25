import os
import argparse
from pathlib import Path
import fnmatch
from typing import List, Set

def matches_pattern(file_path: str, pattern: str) -> bool:
    """
    Check if a file path matches a pattern, supporting ** for recursive matching.
    Converts gitignore-style patterns to work with pathlib.
    """
    # Handle ** patterns by checking if pattern substring exists in path
    if '**' in pattern:
        # Remove leading/trailing **/ 
        pattern_parts = pattern.split('/')
        
        # For patterns like **/node_modules/**, check if any path component matches
        for i, part in enumerate(pattern_parts):
            if part == '**':
                continue
            elif part.endswith('/**'):
                # Pattern like node_modules/** - check if this directory is in path
                dir_name = part[:-3]
                if dir_name in Path(file_path).parts:
                    return True
            elif part.startswith('**/'):
                # Pattern like **/something - check if this is in path
                target = part[3:]
                if target in Path(file_path).parts or fnmatch.fnmatch(file_path, '*/' + target):
                    return True
            else:
                # Regular path component between **
                if part in Path(file_path).parts:
                    # Check if the context matches
                    if i == 0 or (i > 0 and pattern_parts[i-1] == '**'):
                        return True
        
        # Also try direct substring matching for simple **/dir/** patterns
        cleaned_pattern = pattern.replace('**/', '').replace('/**', '')
        if cleaned_pattern and cleaned_pattern in file_path:
            return True
    else:
        # Use standard fnmatch for simple patterns
        if fnmatch.fnmatch(file_path, pattern):
            return True
    
    return False

def get_file_extensions(directory: str) -> Set[str]:
    """Get all unique file extensions in the directory."""
    extensions = set()
    for root, _, files in os.walk(directory):
        for file in files:
            ext = os.path.splitext(file)[1]
            if ext:  # Only add non-empty extensions
                extensions.add(ext)
    return extensions

def get_default_ignore_patterns() -> List[str]:
    """Return common patterns to ignore across programming languages."""
    return [
        # Virtual Environment directories
        '**/venv/**',         # Standard venv name
        '**/*venv/**',        # Names like myvenv, project-venv
        '**/env/**',          # Simple env name
        '**/*.env/**',        # Names like project.env
        '**/virtualenv/**',   # Full virtualenv name
        '**/.virtualenvs/**', # Common virtualenvwrapper directory
        '**/.venv/**',        # Hidden venv directory
        '**/ENV/**',          # Uppercase variation
        '**/python?env/**',   # Names like python3env, pythonenv
        
        # Hidden files and directories
        '**/.*',              # All hidden files and directories
        '**/*~',             # Backup files ending with ~
        '**/*.~*~',          # Files like .file.~undo-tree~
        
        # Build and cache directories
        '**/__pycache__/**',
        '**/node_modules/**',
        '**/build/**',
        '**/dist/**',
        '**/target/**',        # Common Java/Rust build directory
        '**/bin/**',
        '**/obj/**',           # Common C#/C++ build directory
        '**/out/**',           # Common C/C++ build directory
        
        # Compiled and binary files
        '**/*.pyc',
        '**/*.class',
        '**/*.o',
        '**/*.exe',
        '**/*.dll',
        '**/*.so',
        '**/*.dylib',
        '**/*.svg',
        
        # Package files
        '**/*.jar',
        '**/*.war',
        '**/*.ear',
        '**/uv.lock',
        '**/package-lock.json',
        
        # Compressed files
        '**/*.zip',
        '**/*.tar',
        '**/*.gz',
        '**/*.rar',
        
        # Editor backup files
        '**/*~',              # Emacs/Vim backup files
        '**/*.swp',           # Vim swap files
        '**/*.swo',           # Vim swap files
        '**/*.swn',           # Vim swap files
        '**/*.bak',           # Generic backup files
        '**/*#',              # Emacs auto-save files

        # Ignore the script and its project folder
        '**/concat_proj.py',
        '**/concat-proj/**',
        
        # GSM specific ignore patterns
        '**/yomitan/*',
        '**/LICENSE',
        "**/oneocr_results.json",
        '**/*.log',
        '**/websocket_server.py',
        '**/kanji_grid/**',
        '**/ocr_replacements.json',
        '**/ocrerrorfix.json',
        '**/pnpm-lock.yaml',
        '**/GameSentenceMiner.egg-info/**',
        'texthooker/docs/index.html',
        '**/xterm.js',
    ]

def should_include_file(file_path: str, include_patterns: List[str], ignore_patterns: List[str]) -> bool:
    """Check if a file should be included based on patterns."""
    # Convert file path to use forward slashes for consistent pattern matching
    file_path = str(Path(file_path)).replace(os.sep, '/')
    
    # Check if the file or any of its parent directories start with a dot
    parts = Path(file_path).parts
    if any(part.startswith('.') for part in parts):
        return False
        
    # Check if the file ends with a tilde
    if file_path.endswith('~'):
        return False
    
    # First check if file matches any ignore patterns
    for pattern in ignore_patterns:
        if matches_pattern(file_path, pattern):
            return False
    
    # If no include patterns specified, include all non-ignored files
    if not include_patterns:
        return True
    
    print(file_path)
    
    # Check if file matches any include patterns
    for pattern in include_patterns:
        if matches_pattern(file_path, pattern):
            return True
    
    return False

def get_relative_path(file_path: str, root_dir: str) -> str:
    """Get the relative path from root directory."""
    return os.path.relpath(file_path, root_dir)

def concatenate_files(root_dir: str, output_path: str, include_patterns: List[str] = None,
                     ignore_patterns: List[str] = None, show_structure: bool = True) -> None:
    """
    Concatenate files from a project directory into a single file.
    
    Args:
        root_dir: Root directory of the project
        output_path: Path for the output file
        include_patterns: List of glob patterns for files to include
        ignore_patterns: List of glob patterns for files to ignore
        show_structure: Whether to show directory structure in output
    """
    if ignore_patterns is None:
        ignore_patterns = get_default_ignore_patterns()
    
    root_dir = os.path.abspath(root_dir)
    included_files = []
    
    # Collect all files that match the criteria
    for root, _, files in os.walk(root_dir):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = get_relative_path(full_path, root_dir)
            
            if should_include_file(rel_path, include_patterns or [], ignore_patterns):
                included_files.append((rel_path, full_path))
    
    # Sort files for consistent output
    included_files.sort()
    
    with open(output_path, 'w', encoding='utf-8') as outfile:
        # Write project structure if requested
        if show_structure:
            outfile.write(f"Project: {os.path.basename(root_dir)}\n")
            outfile.write("Directory Structure:\n")
            
            current_dirs = []
            for rel_path, _ in included_files:
                parts = Path(rel_path).parts
                for i, part in enumerate(parts[:-1]):
                    if i >= len(current_dirs):
                        current_dirs.append(part)
                        prefix = "    " * i
                        outfile.write(f"{prefix}├── {part}/\n")
                    elif current_dirs[i] != part:
                        current_dirs[i] = part
                        prefix = "    " * i
                        outfile.write(f"{prefix}├── {part}/\n")
                
                prefix = "    " * (len(parts) - 1)
                outfile.write(f"{prefix}├── {parts[-1]}\n")
            
            outfile.write("\nFile Contents:\n")
            outfile.write("="*80 + "\n\n")
        
        # Write file contents
        for rel_path, full_path in included_files:
            try:
                with open(full_path, 'r', encoding='utf-8') as infile:
                    outfile.write(f"\n# File: {rel_path}\n")
                    outfile.write("="*80 + "\n")
                    outfile.write(infile.read())
                    outfile.write("\n" + "-"*80 + "\n")
            except UnicodeDecodeError:
                outfile.write(f"\n# File: {rel_path} (binary file - contents skipped)\n")
                outfile.write("-"*80 + "\n")

def main():
    parser = argparse.ArgumentParser(
        description='Concatenate project files into a single file, including files from all subdirectories.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Combine all files in current project (including subdirectories):
  python concat_proj.py

  # Combine only Python files from a specific project:
  python concat_proj.py --root /path/to/project --include "**.py"

  # Combine Python files from models directory:
  python concat_proj.py --include "**/models/**.py"

  # Combine multiple file types:
  python concat_proj.py --include "**.py" "**.java" "**.c"

  # See all file types in your project:
  python concat_proj.py --list-extensions
        """
    )
    parser.add_argument('--root', '-r', default='.',
                      help='Root directory of the project (default: current directory)')
    parser.add_argument('--output', '-o', default='project_combined.txt',
                      help='Output file path (default: project_combined.txt)')
    parser.add_argument('--include', '-i', nargs='*',
                      help='Glob patterns for files to include (e.g., "**.py" "**.java")')
    parser.add_argument('--ignore', '-x', nargs='*',
                      help='Additional glob patterns for files to ignore')
    parser.add_argument('--no-structure', action='store_true',
                      help='Do not show directory structure in output')
    parser.add_argument('--list-extensions', action='store_true',
                      help='List all file extensions found in the project')
    parser.add_argument('--delete', action='store_true', default=True,
                      help='Delete the output file before creation (for testing purposes)')
    
    args = parser.parse_args()
    
    if args.list_extensions:
        extensions = get_file_extensions(args.root)
        print("File extensions found in project:")
        for ext in sorted(extensions):
            print(f"  {ext}")
        return
    
    # Combine default ignore patterns with user-provided ones
    ignore_patterns = get_default_ignore_patterns()
    if args.ignore:
        ignore_patterns.extend(args.ignore)
    
    concatenate_files(
        root_dir=args.root,
        output_path=args.output,
        include_patterns=args.include,
        ignore_patterns=ignore_patterns,
        show_structure=not args.no_structure
    )
    
    print(f"Files have been combined into {args.output}")
    if args.include:
        print(f"Included patterns: {', '.join(args.include)}")

if __name__ == '__main__':
    main()
