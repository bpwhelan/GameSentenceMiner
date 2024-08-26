import json
import os
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import urllib.request
import azure.cognitiveservices.speech as speechsdk
import subprocess
from difflib import SequenceMatcher

subscription_key = ""
region = ""
folder_to_watch = ""  # Adjust to your OBS output directory
audio_destination = ""
remove_video = True
remove_untrimmed_audio = True


def transcribe_audio_with_azure(audio_path, sentence):
    speech_config = speechsdk.SpeechConfig(subscription=subscription_key, region=region)
    speech_config.speech_recognition_language = "ja-JP"

    audio_input = speechsdk.audio.AudioConfig(filename=audio_path)
    speech_recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_input)

    done = False
    results = []

    def stop_cb(evt):
        print('CLOSING on {}'.format(evt))
        nonlocal done
        done = True

    def recognized_cb(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
            print(f"Recognized: {evt.result.text}")
            recognized_text = evt.result.text
            similarity = SequenceMatcher(None, recognized_text, sentence).ratio()
            if similarity >= .5:
                results.append({
                    'text': recognized_text,
                    'offset': evt.result.offset,
                    'duration': evt.result.duration,
                    'similarity': similarity
                })
        elif evt.result.reason == speechsdk.ResultReason.NoMatch:
            print("NoMatch: Speech could not be recognized.")
        elif evt.result.reason == speechsdk.ResultReason.Canceled:
            cancellation_details = evt.result.cancellation_details
            print(f"Speech Recognition canceled: {cancellation_details.reason}")

    # Connect callbacks to the events fired by the speech recognizer
    speech_recognizer.recognized.connect(recognized_cb)
    speech_recognizer.session_stopped.connect(stop_cb)
    speech_recognizer.canceled.connect(stop_cb)

    # Start the recognition
    speech_recognizer.start_continuous_recognition()

    while not done:
        time.sleep(0.5)

    speech_recognizer.stop_continuous_recognition()

    # Return the full transcription along with offsets and durations
    return results


def trim_audio_by_time(input_audio, start_time, end_time, output_audio):
    command = f"ffmpeg -i \"{input_audio}\" -ss {start_time} -to {end_time} -c copy \"{output_audio}\""
    subprocess.call(command, shell=True)


def convert_opus_to_wav(input_opus, output_wav):
    command = f"ffmpeg -i \"{input_opus}\" \"{output_wav}\""
    subprocess.call(command, shell=True)


def process_audio_with_azure(input_audio, sentence, output_audio):
    # Convert MP3 to WAV
    temp_wav = "temp.wav"
    convert_opus_to_wav(input_audio, temp_wav)

    # Transcribe WAV with Azure
    result = transcribe_audio_with_azure(temp_wav, sentence)[0]

    # Clean up the temporary WAV
    os.remove(temp_wav)

    if result is None:
        print("Failed to transcribe audio")
        return

    duration = result['duration']
    offset = result['offset']

    # Convert start and end index to time
    start_time = offset
    end_time = offset + duration

    # Convert to seconds
    start_time_seconds = start_time / 10 ** 7  # Convert from ticks to seconds
    end_time_seconds = end_time / 10 ** 7

    trim_audio_by_time(input_audio, start_time_seconds, end_time_seconds, output_audio)


class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.endswith(".mkv"):  # Adjust based on your OBS output format
            self.convert_to_audio(event.src_path)

    def convert_to_audio(self, video_path):
        added_ids = invoke('findNotes', query='added:1')
        last_note = invoke('notesInfo', notes=[added_ids[-1]])[0]
        print(last_note)
        tango = last_note['fields']['Word']['value']
        sentence = last_note['fields']['Sentence']['value']
        audio_path = audio_destination + tango + ".opus"

        # FFmpeg command to extract the audio without re-encoding
        command = f"ffmpeg -i \"{video_path}\" -map 0:a -c:a copy \"{audio_path}\""
        print(f"Running Command: {command}")  # Debugging line
        subprocess.call(command, shell=True)

        input_audio = audio_path
        output_audio = audio_path.replace(".opus", "_trimmed.opus")

        process_audio_with_azure(input_audio, sentence, output_audio)
        if remove_video:
            os.remove(video_path)  # Optionally remove the video after conversion
        if remove_untrimmed_audio:
            os.remove(audio_path)


def request(action, **params):
    return {'action': action, 'params': params, 'version': 6}


def invoke(action, **params):
    requestJson = json.dumps(request(action, **params)).encode('utf-8')
    response = json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765', requestJson)))
    if len(response) != 2:
        raise Exception('response has an unexpected number of fields')
    if 'error' not in response:
        raise Exception('response is missing required error field')
    if 'result' not in response:
        raise Exception('response is missing required result field')
    if response['error'] is not None:
        raise Exception(response['error'])
    return response['result']


def test_azure():
    added_ids = invoke('findNotes', query='added:1')
    last_note = invoke('notesInfo', notes=[added_ids[-1]])[0]
    print(last_note)
    tango = last_note['fields']['Word']['value']
    sentence = last_note['fields']['Sentence']['value']
    audio_path = "C:/Users/Beangate/Videos/OBS/Audio/" + tango + ".opus"
    output_audio = audio_path.replace(".opus", "_trimmed.opus")

    process_audio_with_azure(audio_path, sentence, output_audio)


if __name__ == "__main__":
    event_handler = VideoToAudioHandler()
    observer = Observer()
    observer.schedule(event_handler, folder_to_watch, recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(10)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()