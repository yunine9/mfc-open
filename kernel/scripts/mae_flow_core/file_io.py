"""Managed file I/O helpers shared by Mae-Flow runtime adapters."""

import json


def read_text(path, encoding="utf-8", errors=None, limit=-1):
    with open(path, encoding=encoding, errors=errors) as stream:
        return stream.read(limit)


def read_bytes(path, limit=-1):
    with open(path, "rb") as stream:
        return stream.read(limit)


def read_lines(path, encoding="utf-8", errors=None):
    with open(path, encoding=encoding, errors=errors) as stream:
        return stream.readlines()


def load_json(path, encoding="utf-8", errors=None):
    with open(path, encoding=encoding, errors=errors) as stream:
        return json.load(stream)


def write_text(
        path,
        text,
        encoding="utf-8",
        errors=None,
        newline=None,
        mode="w"):
    with open(
            path,
            mode,
            encoding=encoding,
            errors=errors,
            newline=newline) as stream:
        return stream.write(text)
