#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The sharing relay, run inside Anki by the Hachidori Relay add-on.

A Chrome extension cannot listen for connections, so a sharing Hachidori (the
host) and the browsers linked to it all connect out to this relay. The host
connects to /host, linked browsers connect to /link, and the relay forwards
text frames between them without reading them. It listens on this computer
only until the host asks for the network, so that browsers on the person's
other computers can link as well. SharingRelay is that logic; the rest is the
WebSocket server around it, on the standard library alone.

Run it without Anki: python3 extension/anki-relay/server.py --port 8771
"""
from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import ipaddress
import json
import socket
import struct
import sys
import threading
import time
from collections import namedtuple
from contextlib import suppress

DEFAULT_PORT = 8771
HOST_PATH = "/host"
LINK_PATH = "/link"
EXTENSION_ORIGIN_PREFIX = "chrome-extension://"
PING_SECONDS = 20
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONTINUATION, TEXT, CLOSE, PING, PONG = 0x0, 0x1, 0x8, 0x9, 0xA
# Where a UDP socket would send from is this computer's address on that route:
# Tailscale's own resolver first, then the default route. Nothing is sent to
# either address, and the range only labels an address as Tailscale's.
ADDRESS_PROBES = ("100.100.100.100", "8.8.8.8")  # NOSONAR
TAILSCALE_RANGE = ipaddress.ip_network("100.64.0.0/10")  # NOSONAR
ACCEPT_TIMEOUT_SECONDS = 1.0

Handlers = namedtuple("Handlers", ["message", "closed"])
Client = namedtuple("Client", ["connection", "address"])


def encode(frame):
    return json.dumps(frame, ensure_ascii=False)


def is_loopback(address):
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def local_addresses():
    """The addresses other computers reach this one at, Tailscale's first when there is one."""
    found = []
    for target in ADDRESS_PROBES:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.connect((target, 53))
                address = probe.getsockname()[0]
            except OSError:
                continue
        if is_loopback(address) or any(entry["address"] == address for entry in found):
            continue
        kind = "tailscale" if ipaddress.ip_address(address) in TAILSCALE_RANGE else "local"
        found.append({"address": address, "kind": kind})
    return found


class Listener:
    """The listening socket: this computer only, or every interface while the host asks for the network."""

    def __init__(self, port):
        self.port = port
        self.network = False
        self._sock = None
        self._error = None

    def open(self, network):
        """Binds afresh. The old socket goes first: Linux refuses a wildcard bind beside a loopback listener."""
        # The accept loop may wake on the old socket at any point from here on and
        # sees that it is no longer the listener.
        previous, self._sock = self._sock, None
        if previous is not None:
            # Shutdown wakes the accept loop and frees the port on Linux; close alone leaves both to a timeout.
            with suppress(OSError):
                previous.shutdown(socket.SHUT_RDWR)
            previous.close()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if sys.platform != "win32":
            # Frees the port straight after a restart; Windows would instead let two listeners share it.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # The previous socket may linger until the accept loop wakes; that takes at
        # most one timeout. Every interface is bound only while the host asks for it.
        for attempt in range(40):
            try:
                sock.bind(("0.0.0.0" if network else "127.0.0.1", self.port))
                break
            except OSError as error:
                if error.errno != errno.EADDRINUSE or previous is None or attempt == 39:
                    sock.close()
                    self._error = error
                    raise
                time.sleep(0.05)
        sock.listen()
        sock.settimeout(ACCEPT_TIMEOUT_SECONDS)
        self._sock = sock
        self._error = None
        self.port = sock.getsockname()[1]
        self.network = network

    def accept(self):
        """The next connection, or None when nothing arrived before the socket was replaced or timed out."""
        sock = self._sock
        if sock is None:
            if self._error is not None:
                raise self._error
            time.sleep(0.05)
            return None
        try:
            conn, _ = sock.accept()
        except TimeoutError:
            return None
        except OSError:
            if sock is not self._sock:
                return None
            raise
        conn.setblocking(True)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        return conn

    def close(self):
        sock, self._sock = self._sock, None
        if sock is not None:
            sock.close()


class SharingRelay:
    """The host, its linked browsers and the frames between them, behind one lock because every socket runs on its own thread."""

    def __init__(self, listener):
        self._listener = listener
        self._lock = threading.Lock()
        self._host = None
        self._clients = {}
        self._next_client_id = 0
        self.closed = False

    @property
    def has_host(self):
        return self._host is not None

    # Called with the lock held. A rebind that fails falls back to this computer
    # and tells the host why; only a loopback bind that fails as well raises, which
    # ends the host's connection and makes serve() start over.
    def _set_network(self, enabled):
        if enabled != self._listener.network:
            try:
                self._listener.open(enabled)
            except OSError as error:
                self._listener.open(False)
                return {"kind": "network", "enabled": False, "addresses": [], "error": str(error)}
        if not enabled:
            for client in self._clients.values():
                if not is_loopback(client.address):
                    client.connection.close()
        return {"kind": "network", "enabled": enabled, "addresses": local_addresses() if enabled else []}

    def _to_host(self, frame):
        if self._host is not None:
            self._host.send(encode(frame))

    def connect_host(self, sock):
        """The handlers for a new host socket, or None after telling it that another Hachidori already shares here."""
        with self._lock:
            if self._host is not None:
                sock.send(encode({"kind": "listen-failed", "error": "Another browser on this computer is already sharing through Anki."}))
                return None
            self._host = sock
            sock.send(encode({"kind": "listening", "port": self._listener.port}))
        return Handlers(lambda text: self._host_frame(sock, text), lambda: self._host_closed(sock))

    def _host_frame(self, sock, text):
        """One frame from the host: text for one or every linked browser, a close, or the network switch."""
        try:
            frame = json.loads(text)
        except ValueError:
            return
        if not isinstance(frame, dict):
            return
        kind = frame.get("kind")
        with self._lock:
            if kind == "network":
                sock.send(encode(self._set_network(frame.get("enabled") is True)))
            elif kind == "broadcast":
                for client in self._clients.values():
                    client.connection.send(str(frame.get("text")))
            elif kind in ("send", "close"):
                client = self._clients.get(frame.get("clientId"))
                if client is None:
                    return
                if kind == "send":
                    client.connection.send(str(frame.get("text")))
                else:
                    client.connection.close()

    def _host_closed(self, sock):
        with self._lock:
            if self._host is not sock:
                return
            self._host = None
            for client in self._clients.values():
                client.connection.close()
            self._clients.clear()
            if self._listener.network:
                self._set_network(False)

    def connect_client(self, sock, origin, address):
        """The handlers for a new linked-browser socket, or None while no host is connected."""
        with self._lock:
            if self._host is None:
                return None
            self._next_client_id += 1
            client_id = f"client-{self._next_client_id}"
            self._clients[client_id] = Client(sock, address)
            self._to_host({"kind": "client-open", "clientId": client_id, "origin": origin, "address": address})

        def message(text):
            with self._lock:
                self._to_host({"kind": "client-text", "clientId": client_id, "text": text})

        def closed():
            with self._lock:
                if self._clients.pop(client_id, None) is None:
                    return
                self._to_host({"kind": "client-close", "clientId": client_id})

        return Handlers(message, closed)

    def ping(self):
        """Text traffic keeps a Chrome service worker alive; called every 20 s."""
        ping = encode({"kind": "ping"})
        with self._lock:
            if self._host is not None:
                self._host.send(ping)
            for client in self._clients.values():
                client.connection.send(ping)


def encode_frame(opcode, payload):
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", 0x80 | opcode, length)
    elif length < 0x10000:
        header = struct.pack("!BBH", 0x80 | opcode, 126, length)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, length)
    return header + payload


def unmask(payload, mask):
    # One big-integer XOR runs at C speed; a byte loop takes seconds on a 32 MiB lookup reply.
    length = len(payload)
    key = (mask * (length // 4 + 1))[:length]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(length, "big")


class Reader:
    """Blocking reads that keep the bytes which arrived early for the next call."""

    def __init__(self, sock):
        self._sock = sock
        self._buffer = bytearray()

    def _fill(self):
        chunk = self._sock.recv(1 << 20)
        if not chunk:
            raise EOFError
        self._buffer += chunk

    def until(self, marker):
        while True:
            end = self._buffer.find(marker)
            if end != -1:
                return self._take(end + len(marker))
            self._fill()

    def exact(self, count):
        while len(self._buffer) < count:
            self._fill()
        return self._take(count)

    def _take(self, count):
        data = bytes(self._buffer[:count])
        del self._buffer[:count]
        return data

    def frame(self):
        """One WebSocket frame as (final, opcode, payload); browsers always mask what they send."""
        first, second = self.exact(2)
        length = second & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self.exact(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self.exact(8))
        mask = self.exact(4) if second & 0x80 else b""
        payload = self.exact(length)
        return bool(first & 0x80), first & 0x0F, unmask(payload, mask) if mask else payload


class Connection:
    """One socket after its handshake; the relay sees only send() and close()."""

    def __init__(self, sock):
        self._sock = sock
        self._lock = threading.Lock()
        self._closed = False

    def _write(self, opcode, payload):
        with self._lock:
            if self._closed:
                return
            try:
                self._sock.sendall(encode_frame(opcode, payload))
            except OSError:
                # This socket's own thread reports the loss to the relay.
                self._closed = True

    def send(self, text):
        self._write(TEXT, text.encode("utf-8"))

    def pong(self, payload):
        self._write(PONG, payload)

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            # The peer may be gone already; the shutdown still wakes this socket's own thread.
            with suppress(OSError):
                self._sock.sendall(encode_frame(CLOSE, b""))
            with suppress(OSError):
                self._sock.shutdown(socket.SHUT_RDWR)


def parse_request(head):
    """The request path and lower-cased headers of an HTTP upgrade request."""
    lines = head.decode("latin-1").split("\r\n")
    _, target, _ = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        if separator:
            headers[name.strip().lower()] = value.strip()
    return target.split("?")[0], headers


def refusal(relay, path, headers, peer):
    """The HTTP status that turns a handshake away, or None to accept it."""
    if path not in (HOST_PATH, LINK_PATH):
        return "404 Not Found"
    # The one rule: browser extensions may connect, web pages may not. The host
    # is the Hachidori on this computer; other computers only link.
    if not headers.get("origin", "").startswith(EXTENSION_ORIGIN_PREFIX) or (path == HOST_PATH and not is_loopback(peer)):
        return "403 Forbidden"
    if "sec-websocket-key" not in headers:
        return "400 Bad Request"
    # A linked browser is refused while no host is connected; it retries later.
    if path == LINK_PATH and not relay.has_host:
        return "503 Service Unavailable"
    return None


def accept_key(key):
    # RFC 6455 defines the handshake's accept value as SHA-1 over the key; it protects nothing.
    return base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()).decode("ascii")  # NOSONAR


def relay_frames(reader, connection, on_text):
    """Feeds whole text messages to the relay until either side closes."""
    fragments = []
    while True:
        final, opcode, payload = reader.frame()
        if opcode in (CONTINUATION, TEXT):
            fragments.append(payload)
            if final:
                on_text(b"".join(fragments).decode("utf-8"))
                fragments = []
        elif opcode == CLOSE:
            connection.close()
            return
        elif opcode == PING:
            connection.pong(payload)


def serve_connection(relay, sock):
    """One accepted socket from handshake to close, on its own thread."""
    with sock:
        try:
            peer = sock.getpeername()[0]
            reader = Reader(sock)
            path, headers = parse_request(reader.until(b"\r\n\r\n"))
            refused = refusal(relay, path, headers, peer)
            if refused is not None:
                sock.sendall(f"HTTP/1.1 {refused}\r\nConnection: close\r\n\r\n".encode("ascii"))
                return
            sock.sendall((
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_key(headers['sec-websocket-key'])}\r\n\r\n"
            ).encode("ascii"))
            connection = Connection(sock)
            handlers = relay.connect_host(connection) if path == HOST_PATH else relay.connect_client(connection, headers["origin"], peer)
            # A second host was told why; a client that lost the host between the check and here is simply closed.
            if handlers is None:
                connection.close()
                return
            try:
                relay_frames(reader, connection, handlers.message)
            finally:
                handlers.closed()
        except (OSError, EOFError, ValueError):
            # The peer went away or sent something that is not WebSocket text. Inside Anki an
            # uncaught exception on any thread becomes an error dialog, so this ends only this connection.
            return


def ping_forever(relay, seconds):
    while not relay.closed:
        time.sleep(seconds)
        relay.ping()


def serve(port, ping_seconds=PING_SECONDS, announce=None):
    """Relays on 127.0.0.1:port until the process ends. Raises OSError when the port cannot be bound."""
    listener = Listener(port)
    listener.open(False)
    relay = SharingRelay(listener)
    if announce is not None:
        announce(listener.port)
    threading.Thread(target=ping_forever, args=(relay, ping_seconds), name="hachidori-relay-ping", daemon=True).start()
    try:
        while True:
            sock = listener.accept()
            if sock is not None:
                threading.Thread(target=serve_connection, args=(relay, sock), name="hachidori-relay-connection", daemon=True).start()
    finally:
        relay.closed = True
        listener.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the Hachidori sharing relay without Anki.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="port to listen on; 0 picks a free one and prints it")
    parser.add_argument("--ping-seconds", type=float, default=PING_SECONDS, help="seconds between the keep-alive pings")
    args = parser.parse_args(argv)
    serve(args.port, args.ping_seconds, announce=lambda port: print(f"listening {port}", flush=True))


if __name__ == "__main__":
    main()
