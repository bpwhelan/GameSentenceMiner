from PyInstaller.utils.hooks import collect_data_files

# Collect all data files from silero_vad
datas = collect_data_files('silero_vad', include_py_files=True)
