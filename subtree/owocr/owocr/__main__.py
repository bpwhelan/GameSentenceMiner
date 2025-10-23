from GameSentenceMiner.owocr.owocr.run import run, init_config


def main():
    run()

if __name__ == '__main__':
    init_config(True)
    main()
