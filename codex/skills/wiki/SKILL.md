---
name: wiki
description: Use when rendering a wiki Markdown page, including TikZ diagrams, to a PDF from Codex.
---

Run the bundled renderer with two arguments: the wiki/**.md source and a new output.pdf path. Ask for a missing destination if it cannot be inferred from the request. It requires existing pandoc and xelatex; do not install dependencies automatically. It refuses parent escapes, source aliases outside a wiki directory and existing output files. Return the exact output path. Opening the PDF is a separate optional user action.

Resolve `scripts/run.mjs` relative to this SKILL.md and invoke it using its absolute path:

```sh
node /absolute/path/to/this/skill/scripts/run.mjs [arguments]
```

Keep paths as separate quoted arguments. Interpret returned JSON as observations and preserve errors and unknown values.
