# Third-party components bundled by Mae-Flow

Mae-Flow ships fixed copies of the workflow components it executes so users do
not have to install or register project-local Skills.

- Comet 0.3.9 — MIT License, `runtime/vendor/comet/LICENSE`
- OpenSpec 1.6.0 — MIT License, `runtime/vendor/openspec/LICENSE`
- Superpowers — MIT License, `runtime/vendor/superpowers/LICENSE`
- Ponytail — MIT License, `runtime/vendor/ponytail/LICENSE`

Exact source versions are recorded in `runtime/vendor/manifest.json`. Mae-Flow
loads these copies directly; it does not silently use a different globally
installed version.
