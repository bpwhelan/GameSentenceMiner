from PyInstaller.utils.hooks import collect_data_files

# Collect all data files from vosk
datas = collect_data_files('whisper', include_py_files=True)
