"""Explicit late-bound wiring for the CLI module graph."""

class CliApi:
    def __init__(self):
        object.__setattr__(self, "_values", {"FLOW": None})
        object.__setattr__(self, "_modules", [])

    def register(self, module):
        if module not in self._modules:
            self._modules.append(module)
        for name, value in vars(module).items():
            if callable(value) and getattr(value, "__module__", "") == module.__name__:
                self._values[name] = value

    def register_values(self, values):
        self._values.update(values)

    def exports(self):
        return dict(self._values)

    def __getattr__(self, name):
        try:
            return self._values[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name, value):
        if name in {"_values", "_modules"}:
            object.__setattr__(self, name, value)
            return
        self._values[name] = value
        for module in self._modules:
            if name in vars(module):
                setattr(module, name, value)

api = CliApi()
