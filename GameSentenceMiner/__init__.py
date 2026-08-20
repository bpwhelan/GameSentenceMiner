import os

# NumPy's Windows OpenBLAS build otherwise creates one worker per logical CPU
# and commits a 32 MiB scratch buffer for each worker at import time. GSM's
# NumPy usage is not BLAS-heavy, so keep one worker unless the user explicitly
# opts into a different value before launching GSM.
if os.name == "nt":
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

# Remove environment variables that could interfere with managed Python instance
# This prevents conflicts with user's system Python installations and configurations

# Tk/Tcl libraries
os.environ.pop("TCL_LIBRARY", None)
os.environ.pop("TK_LIBRARY", None)

# Python-specific paths that could cause module conflicts
os.environ.pop("PYTHONPATH", None)
os.environ.pop("PYTHONHOME", None)
os.environ.pop("PYTHONSTARTUP", None)
os.environ.pop("PYTHONUSERBASE", None)

# Virtual environment variables
os.environ.pop("VIRTUAL_ENV", None)
os.environ.pop("CONDA_PREFIX", None)
os.environ.pop("CONDA_DEFAULT_ENV", None)
os.environ.pop("CONDA_PYTHON_EXE", None)

# Python version managers
os.environ.pop("PYENV_ROOT", None)
os.environ.pop("PYENV_VERSION", None)
os.environ.pop("PYENV_SHELL", None)

# Poetry package manager
os.environ.pop("POETRY_ACTIVE", None)
os.environ.pop("POETRY_HOME", None)

# Pip configuration that could override behavior
os.environ.pop("PIP_CONFIG_FILE", None)
os.environ.pop("PIP_REQUIRE_VIRTUALENV", None)

# Prevent user site-packages from being loaded
# os.environ['PYTHONNOUSERSITE'] = '1'

# Isolate from system installations
os.environ["PYTHONIOENCODING"] = "utf-8"
