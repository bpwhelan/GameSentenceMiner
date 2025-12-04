import os

# Set a flag to indicate read-only mode for the DB if this script is run directly
if __name__ == "__main__":
    os.environ["GSM_DB_READ_ONLY"] = "1"
    from GameSentenceMiner.web.texthooking_page import start_web_server
    start_web_server(debug=True)