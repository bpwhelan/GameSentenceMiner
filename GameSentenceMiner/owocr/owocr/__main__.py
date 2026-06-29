from GameSentenceMiner.owocr.owocr.ocr_runtime import run, init_config


def main():
    run()


if __name__ == "__main__":
    init_config(True)
    main()
