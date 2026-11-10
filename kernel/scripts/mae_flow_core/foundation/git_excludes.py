"""Keep local runtime ignore rules out of the user's tracked configuration."""

import os


def append_local_excludes(path, entries):
    if not path:
        return
    path = os.path.abspath(path)
    if os.path.islink(path):
        raise OSError("Git 本地排除文件不能是符号链接")
    old = b""
    if os.path.isfile(path):
        with open(path, "rb") as stream:
            old = stream.read()
    existing = {line.strip() for line in old.decode("utf-8", errors="replace").splitlines()
                if line.strip() and not line.lstrip().startswith("#")}
    missing = [entry for entry in dict.fromkeys(entries) if entry not in existing]
    if not missing:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "ab") as stream:
        stream.write((b"\n" if old and not old.endswith(b"\n") else b"")
                     + "\n".join(missing).encode("utf-8") + b"\n")
