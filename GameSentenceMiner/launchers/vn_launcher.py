import os
import subprocess
import threading
import time


vn_path = r"E:\Japanese Stuff\Visual Novels\Example\Example.exe"
texttractor_path = r"E:\Japanese Stuff\Textractor\x86\Textractor.exe"


# Function to launch VN
def launch_vn():
    try:
        os.chdir(vn_path.rsplit('\\',1)[0])
        process = subprocess.Popen(vn_path, stdout=subprocess.DEVNULL)
        return process.pid
    except Exception as e:
        print(f"Error launching VN: {e}")


def launch_textractor():
    try:
        process = subprocess.Popen(texttractor_path, stdout=subprocess.DEVNULL)
        return process.pid
    except Exception as e:
        print(f"Error launching VN: {e}")

def main():
    path = os.getcwd()
    vn_pid = launch_vn()
    os.chdir(path)

    time.sleep(2)

    if vn_pid:
        launch_textractor()
    else:
        print("Failed to launch VN.")


if __name__ == "__main__":
    main()