"""Stable file fingerprints shared by CLI and Hook adapters."""

import hashlib
import os


def path_fingerprint(path):
    """Fingerprint a file or a shallow directory without recursive scans."""
    digest = hashlib.sha256()
    absolute = os.path.abspath(path)
    try:
        if os.path.isfile(absolute):
            digest.update(b"file\0")
            with open(absolute, "rb") as stream:
                for chunk in iter(
                        lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif os.path.isdir(absolute):
            digest.update(b"dir\0")
            for name in sorted(os.listdir(absolute)):
                child = os.path.join(absolute, name)
                stat = os.stat(child)
                digest.update((
                    name + "\0" + str(stat.st_size) + "\0"
                    + str(stat.st_mtime_ns)
                ).encode("utf-8", errors="replace"))
        else:
            digest.update(b"missing\0")
    except OSError as exc:
        digest.update(("error:" + str(exc)).encode(
            "utf-8", errors="replace"))
    return digest.hexdigest()


def _update_review_hash(digest, absolute, path_stat):
    git_mode = path_stat.st_mode & 0o170000
    executable = bool(path_stat.st_mode & 0o100)
    digest.update(("type:%o\0exec:%d\0" % (
        git_mode, executable)).encode("ascii"))
    if os.path.islink(absolute):
        digest.update(b"symlink\0")
        digest.update(os.readlink(absolute).encode(
            "utf-8", errors="surrogateescape"))
        return
    if os.path.isfile(absolute):
        digest.update(b"file\0")
        with open(absolute, "rb") as stream:
            for chunk in iter(
                    lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return
    digest.update(
        b"dir\0" if os.path.isdir(absolute) else b"other\0")


def review_path_fingerprint(path):
    """Hash Git-relevant content, type, and executable-bit state."""
    digest = hashlib.sha256()
    absolute = os.path.abspath(path)
    try:
        _update_review_hash(digest, absolute, os.lstat(absolute))
    except FileNotFoundError:
        digest.update(b"missing\0")
    except OSError as exc:
        digest.update(("error:" + str(exc)).encode(
            "utf-8", errors="replace"))
    return digest.hexdigest()
