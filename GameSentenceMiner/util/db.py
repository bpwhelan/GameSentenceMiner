

from datetime import datetime
import json
import os
import random
import shutil
import sqlite3
from sys import platform
import time
from typing import Any, Dict, List, Optional, Tuple, Union, Type, TypeVar
import threading
import uuid

import pytz
from datetime import timedelta

import regex

from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.util.configuration import get_stats_config, logger, is_dev
import gzip

# Matches any Unicode punctuation (\p{P}), symbol (\p{S}), or separator (\p{Z}); \p{Z} includes whitespace/separator chars
punctuation_regex = regex.compile(r'[\p{P}\p{S}\p{Z}]')

class SQLiteDB:
    """
    Multi-purpose SQLite database utility class for general use.
    Thread-safe for basic operations.
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        
    def backup(self, backup_path: str):
        """ Create a backup of the database using built in SQLite backup API. """
        with self._lock, sqlite3.connect(self.db_path, check_same_thread=False) as conn:
            with sqlite3.connect(backup_path, check_same_thread=False) as backup_conn:
                conn.backup(backup_conn)
                if is_dev:
                    logger.debug(f"Database backed up to {backup_path}")

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
    _column_order_cache: Optional[List[str]] = None  # Cache for actual column order

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not hasattr(cls, '_table') or not cls._table:
            cls._table = cls.__name__.lower()
        if not hasattr(cls, '_fields') or not cls._fields:
            raise NotImplementedError(f"{cls.__name__} must define _fields")

    @classmethod
    def set_db(cls, db: SQLiteDB):
        cls._db = db
        cls._column_order_cache = None  # Reset cache when database changes
        # Ensure table exists
        if not db.table_exists(cls._table):
            fields_def = ', '.join([f"{field} TEXT" for field in cls._fields])
            pk_def = f"{cls._pk} TEXT PRIMARY KEY" if not cls._auto_increment else f"{cls._pk} INTEGER PRIMARY KEY AUTOINCREMENT"
            create_table_sql = f"CREATE TABLE IF NOT EXISTS {cls._table} ({pk_def}, {fields_def})"
            db.create_table(create_table_sql)
        # Check for missing columns and add them
        existing_columns = [col[1] for col in db.fetchall(f"PRAGMA table_info({cls._table})")]
        for field in cls._fields:
            if field not in existing_columns:
                db.execute(f"ALTER TABLE {cls._table} ADD COLUMN {field} TEXT", commit=True)
                cls._column_order_cache = None  # Reset cache when schema changes

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
    def from_row(cls: Type[T], row: Tuple, clean_columns: list = []) -> T:
        if not row:
            return None
        obj = cls()
        
        try:
            # Get actual column order from database schema
            actual_columns = cls.get_actual_column_order()
            expected_fields = [cls._pk] + cls._fields
            
            # Create a mapping from actual column positions to expected field positions
            column_mapping = {}
            for i, actual_col in enumerate(actual_columns):
                if actual_col in expected_fields:
                    expected_index = expected_fields.index(actual_col)
                    column_mapping[i] = expected_index
            
            # Process each column in the row based on the mapping
            for actual_pos, row_value in enumerate(row):
                if actual_pos not in column_mapping:
                    continue  # Skip unknown columns
                    
                expected_pos = column_mapping[actual_pos]
                field = expected_fields[expected_pos]
                field_type = cls._types[expected_pos]
                
                if field in clean_columns and isinstance(row_value, str):
                    row_value = punctuation_regex.sub('', row_value).strip() 
                
                cls._set_field_value(obj, field, field_type, row_value, expected_pos == 0 and field == cls._pk)
                
        except Exception as e:
            # Fallback to original behavior if schema-based mapping fails
            logger.warning(f"Column mapping failed for {cls._table}, falling back to positional mapping: {e}")
            expected_fields = [cls._pk] + cls._fields
            for i, field in enumerate(expected_fields):
                if i >= len(row):
                    break  # Safety check
                field_type = cls._types[i]
                cls._set_field_value(obj, field, field_type, row[i], i == 0 and field == cls._pk)
                    
        return obj
    
    @classmethod
    def _set_field_value(cls, obj, field: str, field_type: type, row_value, is_pk: bool = False):
        """Helper method to set field value with proper type conversion."""
        if is_pk:
            if field_type is int:
                setattr(obj, field, int(row_value) if row_value is not None else None)
            elif field_type is str:
                setattr(obj, field, str(row_value) if row_value is not None else None)
            return
            
        if field_type is str:
            if not row_value:
                setattr(obj, field, "")
            elif isinstance(row_value, str) and (row_value.startswith('[') or row_value.startswith('{')):
                try:
                    setattr(obj, field, json.loads(row_value))
                except json.JSONDecodeError:
                    setattr(obj, field, row_value)
            else:
                setattr(obj, field, str(row_value) if row_value is not None else None)
        elif field_type is list:
            try:
                setattr(obj, field, json.loads(row_value) if row_value else [])
            except json.JSONDecodeError:
                setattr(obj, field, [])
        elif field_type is int:
            setattr(obj, field, int(row_value) if row_value is not None else None)
        elif field_type is float:
            if row_value is None:
                setattr(obj, field, None)
            elif isinstance(row_value, str):
                # Try to parse datetime strings to Unix timestamp
                try:
                    # First try direct float conversion
                    setattr(obj, field, float(row_value))
                except ValueError:
                    # If that fails, try parsing as datetime string
                    try:
                        from datetime import datetime
                        dt = datetime.fromisoformat(row_value.replace(' ', 'T'))
                        setattr(obj, field, dt.timestamp())
                    except (ValueError, AttributeError):
                        # If all parsing fails, set to None
                        logger.warning(f"Could not convert '{row_value}' to float or datetime, setting to None")
                        setattr(obj, field, None)
            else:
                setattr(obj, field, float(row_value))
        elif field_type is bool:
            # Convert from SQLite: 0/1 (int), '0'/'1' (str), or None -> bool
            # Default to False for None/empty, True only for 1 or '1'
            setattr(obj, field, row_value == 1 or row_value == '1')
        elif field_type is dict:
            try:
                setattr(obj, field, json.loads(row_value) if row_value else {})
            except json.JSONDecodeError:
                setattr(obj, field, {})
        else:
            setattr(obj, field, row_value)

    def save(self, retry=1):
        try:
            for field in self._fields:
                field_value = getattr(self, field)
                if isinstance(field_value, list):
                    setattr(self, field, json.dumps(field_value))
                elif isinstance(field_value, bool):
                    # Convert boolean to integer (0 or 1) for SQLite storage
                    setattr(self, field, 1 if field_value else 0)
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
            if self._auto_increment:
                self.save()
            elif pk_val is None:
                raise ValueError(
                    f"Primary key {self._pk} must be set for non-auto-increment tables.")
            else:
                # Serialize list and dict fields to JSON, convert booleans to integers
                for field in self._fields:
                    field_value = getattr(self, field)
                    if isinstance(field_value, (list, dict)):
                        setattr(self, field, json.dumps(field_value))
                    elif isinstance(field_value, bool):
                        # Convert boolean to integer (0 or 1) for SQLite storage
                        setattr(self, field, 1 if field_value else 0)
                
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
            self._db.execute(
                f"ALTER TABLE {self._table} ADD COLUMN {column_name} {new_column_type}", commit=True)
            self.__class__._column_order_cache = None  # Reset cache when schema changes
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
        
    @classmethod
    def has_column(cls, column_name: str) -> bool:
        row = cls._db.fetchone(
            f"PRAGMA table_info({cls._table})")
        if not row:
            return False
        columns = [col[1] for col in cls._db.fetchall(
            f"PRAGMA table_info({cls._table})")]
        return column_name in columns
    
    @classmethod
    def rename_column(cls, old_column: str, new_column: str):
        cls._db.execute(
            f"ALTER TABLE {cls._table} RENAME COLUMN {old_column} TO {new_column}", commit=True)
        cls._column_order_cache = None  # Reset cache when schema changes
        
    @classmethod
    def drop_column(cls, column_name: str):
        cls._db.execute(
            f"ALTER TABLE {cls._table} DROP COLUMN {column_name}", commit=True)
        cls._column_order_cache = None  # Reset cache when schema changes
        
    @classmethod
    def get_column_type(cls, column_name: str) -> Optional[str]:
        row = cls._db.fetchone(
            f"PRAGMA table_info({cls._table})")
        if not row:
            return None
        columns = cls._db.fetchall(
            f"PRAGMA table_info({cls._table})")
        for col in columns:
            if col[1] == column_name:
                return col[2]  # Return the type
        return None
        
    @classmethod
    def alter_column_type(cls, old_column: str, new_column: str, new_type: str):
        # Add new column
        cls._db.execute(
            f"ALTER TABLE {cls._table} ADD COLUMN {new_column} {new_type}", commit=True)
        # Copy and cast data
        cls._db.execute(
            f"UPDATE {cls._table} SET {new_column} = CAST({old_column} AS {new_type})", commit=True)
        cls._db.execute(
            f"ALTER TABLE {cls._table} DROP COLUMN {old_column}", commit=True)
        cls._column_order_cache = None  # Reset cache when schema changes
        
    @classmethod
    def get_actual_column_order(cls) -> List[str]:
        """Get the actual column order from the database schema."""
        if cls._column_order_cache is not None:
            return cls._column_order_cache
            
        # Use direct database access to avoid recursion through from_row()
        with cls._db._lock:
            import sqlite3
            with sqlite3.connect(cls._db.db_path, check_same_thread=False) as conn:
                cursor = conn.cursor()
                cursor.execute(f"PRAGMA table_info({cls._table})")
                columns_info = cursor.fetchall()
                
        # Each row is (cid, name, type, notnull, dflt_value, pk)
        # Sort by column id (cid) to get the actual order
        sorted_columns = sorted(columns_info, key=lambda x: x[0])
        column_order = [col[1] for col in sorted_columns]
        
        # Cache the result
        cls._column_order_cache = column_order
        return column_order
        
    @classmethod
    def get_expected_column_list(cls) -> str:
        """Get comma-separated list of columns in expected order for explicit SELECT queries."""
        expected_fields = [cls._pk] + cls._fields
        return ', '.join(expected_fields)


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
    _fields = ['game_name', 'line_text', 'screenshot_in_anki',
               'audio_in_anki', 'screenshot_path', 'audio_path', 'replay_path', 'translation', 'timestamp', 'original_game_name', 'game_id']
    _types = [str,  # Includes primary key type
              str, str, str, str, str, str, str, str, float, str, str]
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
                 translation: Optional[str] = None,
                 original_game_name: Optional[str] = None,
                 game_id: Optional[str] = None):
        self.id = id
        self.game_name = game_name
        self.line_text = line_text
        self.context = context
        self.timestamp = float(timestamp) if timestamp is not None else datetime.now().timestamp()
        self.screenshot_in_anki = screenshot_in_anki if screenshot_in_anki is not None else ''
        self.audio_in_anki = audio_in_anki if audio_in_anki is not None else ''
        self.screenshot_path = screenshot_path if screenshot_path is not None else ''
        self.audio_path = audio_path if audio_path is not None else ''
        self.replay_path = replay_path if replay_path is not None else ''
        self.translation = translation if translation is not None else ''
        self.original_game_name = original_game_name if original_game_name is not None else ''
        self.game_id = game_id if game_id is not None else ''
        
    @classmethod
    def all(cls, for_stats: bool = False) -> List['GameLinesTable']:
        rows = cls._db.fetchall(f"SELECT * FROM {cls._table}")
        clean_columns = ['line_text'] if for_stats else []
        return [cls.from_row(row, clean_columns=clean_columns) for row in rows]

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
            logger.warning(f"GameLine with id {line_id} not found for update, maybe testing?")
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
    def add_line(cls, gameline: GameLine, game_id: Optional[str] = None):
        new_line = cls(id=gameline.id, game_name=gameline.scene,
                       line_text=gameline.text, timestamp=gameline.time.timestamp(),
                       game_id=game_id if game_id else '')
        # logger.info("Adding GameLine to DB: %s", new_line)
        new_line.add()
        return new_line
    
    @classmethod
    def add_lines(cls, gamelines: List[GameLine]):
        new_lines = [cls(id=gl.id, game_name=gl.scene,
                         line_text=gl.text, timestamp=gl.time.timestamp()) for gl in gamelines]
        # logger.info("Adding %d GameLines to DB", len(new_lines))
        params = [(line.id, line.game_name, line.line_text, line.timestamp, line.screenshot_in_anki,
                   line.audio_in_anki, line.screenshot_path, line.audio_path, line.replay_path, line.translation)
                  for line in new_lines]
        cls._db.executemany(
            f"INSERT INTO {cls._table} (id, game_name, line_text, timestamp, screenshot_in_anki, audio_in_anki, screenshot_path, audio_path, replay_path, translation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params,
            commit=True
        )
        
    @classmethod
    def get_lines_filtered_by_timestamp(cls, start: Optional[float] = None, end: Optional[float] = None, for_stats=False) -> List['GameLinesTable']:
        """
        Fetches all lines optionally filtered by start and end timestamps.
        If start or end is None, that bound is ignored.
        """
        query = f"SELECT * FROM {cls._table}"
        conditions = []
        params = []

        # Add timestamp conditions if provided
        if start is not None:
            conditions.append("timestamp >= ?")
            params.append(start)
        if end is not None:
            conditions.append("timestamp <= ?")
            params.append(end)

        # Combine conditions into WHERE clause if any
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Sort by timestamp ascending
        query += " ORDER BY timestamp ASC"

        # Execute the query
        rows = cls._db.fetchall(query, tuple(params))
        clean_columns = ['line_text'] if for_stats else []
        return [cls.from_row(row, clean_columns=clean_columns) for row in rows]

# Ensure database directory exists and return path
def get_db_directory(test=False, delete_test=False) -> str:
    if platform == 'win32':  # Windows
        appdata_dir = os.getenv('APPDATA')
    else:  # macOS and Linux
        appdata_dir = os.path.expanduser('~/.config')
    config_dir = os.path.join(appdata_dir, 'GameSentenceMiner')
    # Create the directory if it doesn't exist
    os.makedirs(config_dir, exist_ok=True)
    path = os.path.join(config_dir, 'gsm.db' if not test else 'gsm_test.db')
    if test and delete_test:
        if os.path.exists(path):
            os.remove(path)
    return path


# Backup and compress the database on load, with today's date, up to 5 days ago (clean up old backups)
def backup_db(db_path: str):
    
    # Create a backup of the backups on migration
    pre_jiten_merge_backup = os.path.join(os.path.dirname(db_path), "backup", "database", "pre_jiten")
    if not os.path.exists(pre_jiten_merge_backup):
        os.makedirs(pre_jiten_merge_backup, exist_ok=True)
        for fname in os.listdir(os.path.join(os.path.dirname(db_path), "backup", "database")):
            fpath = os.path.join(os.path.dirname(db_path), "backup", "database", fname)
            if os.path.isfile(fpath):
                shutil.copy2(fpath, pre_jiten_merge_backup)
                
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

# db_path = get_db_directory(test=True, delete_test=False)

gsm_db = SQLiteDB(db_path)

# Import GamesTable, CronTable, and StatsRollupTable after gsm_db is created to avoid circular import
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.cron_table import CronTable
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable

for cls in [AIModelsTable, GameLinesTable, GamesTable, CronTable, StatsRollupTable]:
    cls.set_db(gsm_db)
    # Uncomment to start fresh every time
    # cls.drop()
    # cls.set_db(gsm_db)  # --- IGNORE ---
    
# GameLinesTable.drop_column('timestamp')
    
# if GameLinesTable.has_column('timestamp_old'):
#     GameLinesTable.alter_column_type('timestamp_old', 'timestamp', 'TEXT')
#     logger.info("Altered 'timestamp_old' column to 'timestamp' with TEXT type in GameLinesTable.")

def check_and_run_migrations():
    def migrate_timestamp():
        if GameLinesTable.has_column('timestamp') and GameLinesTable.get_column_type('timestamp') != 'REAL':
            logger.info("Migrating 'timestamp' column to REAL type in GameLinesTable.")
            # Rename 'timestamp' to 'timestamp_old'
            GameLinesTable.rename_column('timestamp', 'timestamp_old')
            # Copy and cast data from old column to new column
            GameLinesTable.alter_column_type('timestamp_old', 'timestamp', 'REAL')
            logger.info("Migrated 'timestamp' column to REAL type in GameLinesTable.")
    
    def migrate_obs_scene_name():
        """
        Add obs_scene_name column to games table and populate it from game_lines.
        This migration ensures existing games have their OBS scene names preserved.
        """
        if not GamesTable.has_column('obs_scene_name'):
            logger.info("Adding 'obs_scene_name' column to games table...")
            GamesTable._db.execute(
                f"ALTER TABLE {GamesTable._table} ADD COLUMN obs_scene_name TEXT",
                commit=True
            )
            logger.info("Added 'obs_scene_name' column to games table.")
            
            # Populate obs_scene_name for existing games by querying game_lines
            logger.info("Populating obs_scene_name from game_lines...")
            all_games = GamesTable.all()
            updated_count = 0
            
            for game in all_games:
                # Find the first game_line with this game_id to get the original game_name
                result = GameLinesTable._db.fetchone(
                    f"SELECT game_name FROM {GameLinesTable._table} WHERE game_id=? LIMIT 1",
                    (game.id,)
                )
                
                if result and result[0]:
                    obs_scene_name = result[0]
                    # Update the game with the obs_scene_name
                    GamesTable._db.execute(
                        f"UPDATE {GamesTable._table} SET obs_scene_name=? WHERE id=?",
                        (obs_scene_name, game.id),
                        commit=True
                    )
                    updated_count += 1
                    logger.debug(f"Set obs_scene_name='{obs_scene_name}' for game id={game.id}")
            
            logger.info(f"Migration complete: Updated {updated_count} games with obs_scene_name from game_lines.")
        else:
            logger.debug("obs_scene_name column already exists in games table, skipping migration.")
        """
        Convert datetime strings in cron_table to Unix timestamps.
        This migration handles legacy data that may have datetime strings instead of floats.
        """
        try:
            # Get all rows directly from database to check for datetime strings
            rows = CronTable._db.fetchall(f"SELECT id, last_run, next_run, created_at FROM {CronTable._table}")
            
            updates_needed = []
            for row in rows:
                cron_id, last_run, next_run, created_at = row
                needs_update = False
                new_last_run = last_run
                new_next_run = next_run
                new_created_at = created_at
                
                # Check and convert last_run
                if last_run and isinstance(last_run, str) and not last_run.replace('.', '', 1).isdigit():
                    try:
                        dt = datetime.fromisoformat(last_run.replace(' ', 'T'))
                        new_last_run = dt.timestamp()
                        needs_update = True
                    except (ValueError, AttributeError):
                        logger.warning(f"Could not parse last_run '{last_run}' for cron id={cron_id}")
                        new_last_run = None
                        needs_update = True
                
                # Check and convert next_run
                if next_run and isinstance(next_run, str) and not next_run.replace('.', '', 1).isdigit():
                    try:
                        dt = datetime.fromisoformat(next_run.replace(' ', 'T'))
                        new_next_run = dt.timestamp()
                        needs_update = True
                    except (ValueError, AttributeError):
                        logger.warning(f"Could not parse next_run '{next_run}' for cron id={cron_id}")
                        new_next_run = time.time()
                        needs_update = True
                
                # Check and convert created_at
                if created_at and isinstance(created_at, str) and not created_at.replace('.', '', 1).isdigit():
                    try:
                        dt = datetime.fromisoformat(created_at.replace(' ', 'T'))
                        new_created_at = dt.timestamp()
                        needs_update = True
                    except (ValueError, AttributeError):
                        logger.warning(f"Could not parse created_at '{created_at}' for cron id={cron_id}")
                        new_created_at = time.time()
                        needs_update = True
                
                if needs_update:
                    updates_needed.append((new_last_run, new_next_run, new_created_at, cron_id))
            
            # Apply updates
            if updates_needed:
                logger.info(f"Migrating {len(updates_needed)} cron entries with datetime strings to Unix timestamps...")
                for new_last_run, new_next_run, new_created_at, cron_id in updates_needed:
                    CronTable._db.execute(
                        f"UPDATE {CronTable._table} SET last_run=?, next_run=?, created_at=? WHERE id=?",
                        (new_last_run, new_next_run, new_created_at, cron_id),
                        commit=True
                    )
                logger.info(f"✅ Migrated {len(updates_needed)} cron entries to Unix timestamps")
            else:
                logger.debug("No cron timestamp migration needed")
                
        except Exception as e:
            logger.error(f"Error during cron timestamp migration: {e}")
    
    def migrate_jiten_cron_job():
        """
        Create the monthly jiten.moe update cron job if it doesn't exist.
        This ensures the cron job is automatically registered on database initialization.
        """
        existing_cron = CronTable.get_by_name('jiten_sync')
        if not existing_cron:
            logger.info("Creating monthly jiten.moe update cron job...")
            # Calculate next run: first day of next month at midnight
            now = datetime.now()
            if now.month == 12:
                next_month = datetime(now.year + 1, 1, 1, 0, 0, 0)
            else:
                next_month = datetime(now.year, now.month + 1, 1, 0, 0, 0)
            
            CronTable.create_cron_entry(
                name='jiten_sync',
                description='Automatically update all linked games from jiten.moe database (respects manual overrides)',
                next_run=next_month.timestamp(),
                schedule='monthly'
            )
            logger.info(f"✅ Created jiten_sync cron job - next run: {next_month.strftime('%Y-%m-%d %H:%M:%S')}")
        else:
            logger.debug("jiten_sync cron job already exists, skipping creation.")
    
    def migrate_daily_rollup_cron_job():
        """
        Create the daily statistics rollup cron job if it doesn't exist.
        This ensures the cron job is automatically registered on database initialization.
        """
        existing_cron = CronTable.get_by_name('daily_stats_rollup')
        if not existing_cron:
            logger.info("Creating daily statistics rollup cron job...")
            # Schedule for 1 minute ago to ensure it runs immediately on first startup
            now = datetime.now()
            one_minute_ago = now - timedelta(minutes=1)
            
            CronTable.create_cron_entry(
                name='daily_stats_rollup',
                description='Roll up daily statistics for all dates up to yesterday',
                next_run=one_minute_ago.timestamp(),
                schedule='daily'
            )
            logger.info(f"✅ Created daily_stats_rollup cron job - scheduled to run immediately (next_run: {one_minute_ago.strftime('%Y-%m-%d %H:%M:%S')})")
        else:
            logger.debug("daily_stats_rollup cron job already exists, skipping creation.")
    
    def migrate_populate_games_cron_job():
        """
        Create the one-time populate_games cron job if it doesn't exist.
        This ensures games table is populated before the daily rollup runs.
        Runs once and auto-disables (schedule='once').
        """
        existing_cron = CronTable.get_by_name('populate_games')
        if not existing_cron:
            logger.info("Creating one-time populate_games cron job...")
            # Schedule to run immediately (2 minutes ago to ensure it runs before rollup)
            now = datetime.now()
            two_minutes_ago = now - timedelta(minutes=2)
            
            CronTable.create_cron_entry(
                name='populate_games',
                description='One-time auto-creation of game records from game_lines (runs before rollup)',
                next_run=two_minutes_ago.timestamp(),
                schedule='weekly'  # Will auto-disable after running
            )
            logger.info(f"✅ Created populate_games cron job - scheduled to run immediately (next_run: {two_minutes_ago.strftime('%Y-%m-%d %H:%M:%S')})")
        else:
            logger.debug("populate_games cron job already exists, skipping creation.")
    
    migrate_timestamp()
    migrate_obs_scene_name()
    # migrate_cron_timestamps()  # Disabled - user will manually clean up data
    migrate_jiten_cron_job()
    migrate_populate_games_cron_job()  # Run BEFORE daily_rollup to ensure games exist
    migrate_daily_rollup_cron_job()
        
check_and_run_migrations()
    
# all_lines = GameLinesTable.all()


# # Convert String timestamp to float timestamp
# for line in all_lines:
#     if isinstance(line.timestamp, str):
#         try:
#             line.timestamp = float(line.timestamp)
#         except ValueError:
#             # Handle invalid timestamp format
#             line.timestamp = 0.0
#     line.save()

# import random
# import uuid
# from datetime import datetime
# from GameSentenceMiner.util.text_log import GameLine
# from GameSentenceMiner.util.db import GameLinesTable

# # List of common Japanese characters (kanji, hiragana, katakana)
# japanese_chars = (
#     "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
#     "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"
#     "亜唖娃阿哀愛挨悪握圧扱宛嵐安暗案闇以衣位囲医依委威為胃尉異移維緯"
#     # ... (add more kanji for more variety)
# )

# def random_japanese_text(length):
#     return ''.join(random.choices(japanese_chars, k=length))

# batch_size = 1000
# lines_batch = []

# def random_datetime(start_year=2024, end_year=2026):
#     start = datetime(start_year, 1, 1, 0, 0, 0)
#     end = datetime(end_year, 12, 31, 23, 59, 59)
#     delta = end - start
#     random_seconds = random.randint(0, int(delta.total_seconds()))
#     return start + timedelta(seconds=random_seconds)

# from datetime import timedelta

# for i in range(500000):  # Adjust for desired number of lines
#     line_text = random_japanese_text(random.randint(25, 40))
#     lines_batch.append(GameLine(
#         id=str(uuid.uuid1()),
#         text=line_text,
#         time=random_datetime(),
#         prev=None,
#         next=None,
#         index=i,
#         scene="RandomScene"
#     ))
    
#     if len(lines_batch) >= batch_size:
#         GameLinesTable.add_lines(lines_batch)
#         GameLinesTable2.add_lines(lines_batch)
#         lines_batch = []
#     if i % 1000 == 0:
#         print(f"Inserted {i} lines...")

# # Insert any remaining lines
# if lines_batch:
#     GameLinesTable.add_lines(lines_batch)
#     GameLinesTable2.add_lines(lines_batch)
# for _ in range(10):  # Run multiple times to see consistent timing
#     start_time = time.time()
#     GameLinesTable.all()
#     end_time = time.time()

#     print(f"Time taken to query all lines from GameLinesTable: {end_time - start_time:.2f} seconds")

#     start_time = time.time()
#     GameLinesTable2.all()
#     end_time = time.time()

#     print(f"Time taken to query all lines from GameLinesTable2: {end_time - start_time:.2f} seconds")

# print("Done populating GameLinesTable and GameLinesTable2 with random Japanese text.")
