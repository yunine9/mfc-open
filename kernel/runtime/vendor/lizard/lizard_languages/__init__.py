"""Mae-Flow's minimal Lizard language registry.

This package contains the unchanged Lizard 1.23.0 readers needed by Mae-Flow.
Keeping the registry deliberately small avoids importing optional parsers such
as Erlang, which would otherwise pull in third-party runtime dependencies.
"""

from .clike import CLikeReader
from .java import JavaReader
from .javascript import JavaScriptReader
from .python import PythonReader
from .tsx import TSXReader
from .typescript import TypeScriptReader

# Mae-Flow's source scope treats Python stub files as Python as well.
PythonReader.ext = ["py", "pyi"]
TypeScriptReader.ext = ["ts", "cts", "mts"]


def languages():
    return [
        CLikeReader,
        JavaReader,
        JavaScriptReader,
        PythonReader,
        TypeScriptReader,
        TSXReader,
    ]


def get_reader_for(filename):
    for language in languages():
        if language.match_filename(filename):
            return language
    return None
