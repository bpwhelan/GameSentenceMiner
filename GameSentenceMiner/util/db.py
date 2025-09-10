

import json
import os
import shutil
import sqlite3
from sys import platform
import time
from typing import Any, Dict, List, Optional, Tuple, Union, Type, TypeVar
import threading

from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.util.configuration import logger, is_dev
import gzip


class SQLiteDB:
    """
    Multi-purpose SQLite database utility class for general use.
    Thread-safe for basic operations.
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()

    def execute(self, query: str, params: Union[Tuple, Dict] = (), commit: bool = False) -> sqlite3.Cursor:
        with self._lock, sqlite3.connect(self.db_path, check_same_thread=False) as conn:
            if is_dev:
                logger.debug(f"Executed query: {query} with params: {params}")
            cur = conn.cursor()
            cur.execute(query, params)
            if commit:
                conn.commit()
            return cur

    def executemany(self, query: str, seq_of_params: List[Union[Tuple, Dict]], commit: bool = False) -> sqlite3.Cursor:
        with self._lock, sqlite3.connect(self.db_path, check_same_thread=False) as conn:
            cur = conn.cursor()
            cur.executemany(query, seq_of_params)
            if commit:
                conn.commit()
            return cur

    def fetchall(self, query: str, params: Union[Tuple, Dict] = ()) -> List[Tuple]:
        cur = self.execute(query, params)
        return cur.fetchall()

    def fetchone(self, query: str, params: Union[Tuple, Dict] = ()) -> Optional[Tuple]:
        cur = self.execute(query, params)
        return cur.fetchone()

    def create_table(self, table_sql: str):
        self.execute(table_sql, commit=True)

    def table_exists(self, table: str) -> bool:
        result = self.fetchone(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        return result is not None

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


# Abstract base for table-mapped classes
T = TypeVar('T', bound='SQLiteDBTable')


class SQLiteDBTable:
    _db: SQLiteDB = None
    _table: str = ''
    _fields: List[str] = []
    _types: List[type] = []
    _pk: str = 'id'
    _auto_increment: bool = True

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not hasattr(cls, '_table') or not cls._table:
            cls._table = cls.__name__.lower()
        if not hasattr(cls, '_fields') or not cls._fields:
            raise NotImplementedError(f"{cls.__name__} must define _fields")

    @classmethod
    def set_db(cls, db: SQLiteDB):
        cls._db = db
        # Ensure table exists
        if not db.table_exists(cls._table):
            fields_def = ', '.join([f"{field} TEXT" for field in cls._fields])
            pk_def = f"{cls._pk} TEXT PRIMARY KEY" if not cls._auto_increment else f"{cls._pk} INTEGER PRIMARY KEY AUTOINCREMENT"
            create_table_sql = f"CREATE TABLE IF NOT EXISTS {cls._table} ({pk_def}, {fields_def})"
            db.create_table(create_table_sql)

    @classmethod
    def all(cls: Type[T]) -> List[T]:
        rows = cls._db.fetchall(f"SELECT * FROM {cls._table}")
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get(cls: Type[T], pk_value: Any) -> Optional[T]:
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE {cls._pk}=?", (pk_value,))
        return cls.from_row(row) if row else None

    @classmethod
    def one(cls: Type[T]) -> Optional[T]:
        row = cls._db.fetchone(f"SELECT * FROM {cls._table} LIMIT 1")
        return cls.from_row(row) if row else None

    @classmethod
    def from_row(cls: Type[T], row: Tuple) -> T:
        if not row:
            return None
        obj = cls()
        fields = [cls._pk] + cls._fields
        for i, field in enumerate(fields):
            if i == 0 and field == cls._pk:
                if cls._types[i] == int:
                    setattr(obj, field, int(row[i])
                            if row[i] is not None else None)
                elif cls._types[i] == str:
                    setattr(obj, field, str(row[i])
                            if row[i] is not None else None)
                continue
            if cls._types[i] == str:
                if (row[i].startswith('[') or row[i].startswith('{')):
                    try:
                        setattr(obj, field, json.loads(row[i]))
                    except json.JSONDecodeError:
                        setattr(obj, field, row[i])
                else:
                    setattr(obj, field, str(row[i])
                            if row[i] is not None else None)
            elif cls._types[i] == list:
                try:
                    setattr(obj, field, json.loads(row[i]) if row[i] else [])
                except json.JSONDecodeError:
                    setattr(obj, field, [])
            elif cls._types[i] == int:
                setattr(obj, field, int(row[i])
                        if row[i] is not None else None)
            elif cls._types[i] == float:
                setattr(obj, field, float(row[i])
                        if row[i] is not None else None)
            elif cls._types[i] == bool:
                setattr(obj, field, bool(row[i])
                        if row[i] is not None else None)
            elif cls._types[i] == dict:
                try:
                    setattr(obj, field, json.loads(row[i]) if row[i] else {})
                except json.JSONDecodeError:
                    setattr(obj, field, {})
            else:
                setattr(obj, field, row[i])
        return obj

    def save(self, retry=1):
        try:
            for field in self._fields:
                if isinstance(getattr(self, field), list):
                    setattr(self, field, json.dumps(getattr(self, field)))
            data = {field: getattr(self, field) for field in self._fields}
            pk_val = getattr(self, self._pk, None)
            if pk_val is None:
                # Insert
                keys = ', '.join(data.keys())
                placeholders = ', '.join(['?'] * len(data))
                values = tuple(data.values())
                query = f"INSERT INTO {self._table} ({keys}) VALUES ({placeholders})"
                cur = self._db.execute(query, values, commit=True)
                setattr(self, self._pk, cur.lastrowid)
                logger.debug(f"Inserted into {self._table} id={cur.lastrowid}")
            else:
                # Update
                set_clause = ', '.join([f"{k}=?" for k in data.keys()])
                values = tuple(data.values())
                query = f"UPDATE {self._table} SET {set_clause} WHERE {self._pk}=?"
                self._db.execute(query, values + (pk_val,), commit=True)
                logger.debug(f"Updated {self._table} id={pk_val}")
        except sqlite3.OperationalError as e:
            if retry <= 0:
                logger.error(f"Failed to save record to {self._table}: {e}")
                return
            if "no column named" in str(e):
                new_column = str(e).split("no column named ")[1].strip()
                logger.info(f"Adding missing column {new_column} to {self._table}")
                # Get type of new column from self._types by matching column name in _fields
                if new_column in self._fields:
                    self.add_column(new_column)
                    self.save(retry=retry - 1)  # Retry after adding column

    def add(self, retry=1):
        try:
            pk_val = getattr(self, self._pk, None)
            if cls._auto_increment:
                self.save()
            elif pk_val is None:
                raise ValueError(
                    f"Primary key {self._pk} must be set for non-auto-increment tables.")
            else:
                keys = ', '.join(self._fields + [self._pk])
                placeholders = ', '.join(['?'] * (len(self._fields) + 1))
                values = tuple(getattr(self, field)
                            for field in self._fields) + (pk_val,)
                query = f"INSERT INTO {self._table} ({keys}) VALUES ({placeholders})"
                self._db.execute(query, values, commit=True)
        except sqlite3.OperationalError as e:
            if retry <= 0:
                logger.error(f"Failed to add record to {self._table}: {e}")
                return
            if "no column named" in str(e):
                new_column = str(e).split("no column named ")[1].strip()
                logger.info(f"Adding missing column {new_column} to {self._table}")
                # Get type of new column from self._types by matching column name in _fields
                if new_column in self._fields:
                    self.add_column(new_column)
                    self.add(retry=retry - 1)  # Retry after adding column
            
    def add_column(self, column_name: str, new_column_type: str = "TEXT"):
        try:
            index = self._fields.index(column_name) + 1
            self._db.execute(
                f"ALTER TABLE {self._table} ADD COLUMN {column_name} {new_column_type}", commit=True)
            logger.info(f"Added column {column_name} to {self._table}")
        except sqlite3.OperationalError as e:
            if "duplicate column name" in str(e):
                logger.warning(
                    f"Column {column_name} already exists in {self._table}.")
            else:
                logger.error(
                    f"Failed to add column {column_name} to {self._table}: {e}")

    def delete(self):
        pk_val = getattr(self, self._pk, None)
        if pk_val is not None:
            query = f"DELETE FROM {self._table} WHERE {self._pk}=?"
            self._db.execute(query, (pk_val,), commit=True)

    def print(self):
        pk_val = getattr(self, self._pk, None)
        logger.info(f"{self._table} Record (id={pk_val}): " +
                    ', '.join([f"{field}={getattr(self, field)}" for field in self._fields]))

    @classmethod
    def drop(cls):
        cls._db.execute(f"DROP TABLE IF EXISTS {cls._table}", commit=True)


class AIModelsTable(SQLiteDBTable):
    _table = 'ai_models'
    _fields = ['gemini_models', 'groq_models', 'last_updated']
    _types = [int,  # Includes primary key type
              list, list, float]
    _pk = 'id'

    def __init__(self, id: Optional[int] = None, gemini_models: list = None, groq_models: list = None, last_updated: Optional[float] = None):
        self.id = id
        self.gemini_models = gemini_models if gemini_models is not None else []
        self.groq_models = groq_models if groq_models is not None else []
        self.last_updated = last_updated

    @classmethod
    def get_gemini_models(cls) -> List[str]:
        rows = cls.all()
        return rows[0].gemini_models if rows else []

    @classmethod
    def get_groq_models(cls) -> List[str]:
        rows = cls.all()
        return rows[0].groq_models if rows else []

    @classmethod
    def update_models(cls, gemini_models: List[str], groq_models: List[str]):
        models = cls.one()
        if not models:
            new_model = cls(gemini_models=gemini_models,
                            groq_models=groq_models, last_updated=time.time())
            new_model.save()
            return
        if models.gemini_models:
            models.gemini_models = gemini_models
        if models.groq_models:
            models.groq_models = groq_models
        models.last_updated = time.time()
        models.save()

    @classmethod
    def set_gemini_models(cls, models: List[str]):
        models = cls.all()
        if not models:
            new_model = cls(gemini_models=models,
                            groq_models=[], last_updated=time.time())
            new_model.save()
            return
        for model in models:
            model.gemini_models = models
            model.last_updated = time.time()
            model.save()

    @classmethod
    def set_groq_models(cls, models: List[str]):
        models = cls.all()
        if not models:
            new_model = cls(gemini_models=[], groq_models=models,
                            last_updated=time.time())
            new_model.save()
            return
        for model in models:
            model.groq_models = models
            model.last_updated = time.time()
            model.save()


class GameLinesTable(SQLiteDBTable):
    _table = 'game_lines'
    _fields = ['game_name', 'line_text', 'timestamp', 'screenshot_in_anki',
               'audio_in_anki', 'screenshot_path', 'audio_path', 'replay_path', 'translation']
    _types = [str,  # Includes primary key type
              str, str, str, str, str, str, str, str, str]
    _pk = 'id'
    _auto_increment = False  # Use string IDs

    def __init__(self, id: Optional[str] = None,
                 game_name: Optional[str] = None,
                 line_text: Optional[str] = None,
                 context: Optional[str] = None,
                 timestamp: Optional[float] = None,
                 screenshot_in_anki: Optional[str] = None,
                 audio_in_anki: Optional[str] = None,
                 screenshot_path: Optional[str] = None,
                 audio_path: Optional[str] = None,
                 replay_path: Optional[str] = None,
                 translation: Optional[str] = None):
        self.id = id
        self.game_name = game_name
        self.line_text = line_text
        self.context = context
        self.timestamp = timestamp if timestamp is not None else time.time()
        self.screenshot_in_anki = screenshot_in_anki if screenshot_in_anki is not None else ''
        self.audio_in_anki = audio_in_anki if audio_in_anki is not None else ''
        self.screenshot_path = screenshot_path if screenshot_path is not None else ''
        self.audio_path = audio_path if audio_path is not None else ''
        self.replay_path = replay_path if replay_path is not None else ''
        self.translation = translation if translation is not None else ''

    @classmethod
    def get_all_lines_for_scene(cls, game_name: str) -> List['GameLinesTable']:
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE game_name=?", (game_name,))
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_all_games_with_lines(cls) -> List[str]:
        rows = cls._db.fetchall(f"SELECT DISTINCT game_name FROM {cls._table}")
        return [row[0] for row in rows if row[0] is not None]

    @classmethod
    def update(cls, line_id: str, audio_in_anki: Optional[str] = None, screenshot_in_anki: Optional[str] = None, audio_path: Optional[str] = None, screenshot_path: Optional[str] = None, replay_path: Optional[str] = None, translation: Optional[str] = None):
        line = cls.get(line_id)
        if not line:
            logger.warning(f"GameLine with id {line_id} not found for update.")
            return
        if screenshot_path is not None:
            line.screenshot_path = screenshot_path
        if audio_path is not None:
            line.audio_path = audio_path
        if replay_path is not None:
            line.replay_path = replay_path
        if screenshot_in_anki is not None:
            line.screenshot_in_anki = screenshot_in_anki
        if audio_in_anki is not None:
            line.audio_in_anki = audio_in_anki
        if translation is not None:
            line.translation = translation
        line.save()
        logger.debug(f"Updated GameLine id={line_id} paths.")

    @classmethod
    def add_line(cls, gameline: GameLine):
        new_line = cls(id=gameline.id, game_name=gameline.scene,
                       line_text=gameline.text, timestamp=gameline.time.timestamp())
        # logger.info("Adding GameLine to DB: %s", new_line)
        new_line.add()
        return new_line


def get_db_directory():
    if platform == 'win32':  # Windows
        appdata_dir = os.getenv('APPDATA')
    else:  # macOS and Linux
        appdata_dir = os.path.expanduser('~/.config')
    config_dir = os.path.join(appdata_dir, 'GameSentenceMiner')
    # Create the directory if it doesn't exist
    os.makedirs(config_dir, exist_ok=True)
    return os.path.join(config_dir, 'gsm.db')


# Backup and compress the database on load, with today's date, up to 5 days ago (clean up old backups)
def backup_db(db_path: str):
    backup_dir = os.path.join(os.path.dirname(db_path), "backup", "database")
    os.makedirs(backup_dir, exist_ok=True)
    today = time.strftime("%Y-%m-%d")
    backup_file = os.path.join(backup_dir, f"gsm_{today}.db.gz")
    
    # Test, remove backups older than 60 minutes
    # cutoff = time.time() - 60 * 60
    # Clean up backups older than 5 days
    cutoff = time.time() - 5 * 24 * 60 * 60
    for fname in os.listdir(backup_dir):
        fpath = os.path.join(backup_dir, fname)
        if fname.startswith("gsm_") and fname.endswith(".db.gz"):
            try:
                file_time = os.path.getmtime(fpath)
                if file_time < cutoff:
                    os.remove(fpath)
                    logger.info(f"Old backup removed: {fpath}")
            except Exception as e:
                logger.warning(f"Failed to remove old backup {fpath}: {e}")

    # Create backup if not already present for today
    if not os.path.exists(backup_file):
        with open(db_path, "rb") as f_in, open(backup_file, "wb") as f_out:
            with gzip.GzipFile(fileobj=f_out, mode="wb") as gz_out:
                shutil.copyfileobj(f_in, gz_out)
        logger.info(f"Database backup created: {backup_file}")

db_path = get_db_directory()
if os.path.exists(db_path):
    backup_db(db_path)

gsm_db = SQLiteDB(db_path)

for cls in [AIModelsTable, GameLinesTable]:
    cls.set_db(gsm_db)
    # Uncomment to start fresh every time
    # cls.drop()
    # cls.set_db(gsm_db)  # --- IGNORE ---
