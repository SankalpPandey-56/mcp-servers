# Offline evidence for existing PDF MCP operations

On 27 October 2026, the existing free PDF server passed 18 checks through its real MCP stdio transport with macOS network access denied. The tested source was commit `1357aabb6e8968ca142cc2635d4e0e7b3327a1e3`. No PDF or license runtime code was changed.

The runner makes two deterministic synthetic two-page PDFs, 864 bytes each. It sends requests to `servers/pdf/dist/index.js` and checks written files with Poppler, independently of pdf-lib. No real documents, account credentials, license keys or existing business profiles are loaded.

The checks cover info, text extraction, merge order, page extraction with duplicates, split, selected-page rotation and the free PAID stamp. They also confirm Pro refusals, input and output path protections, an invalid page and rotation, URL rejection, unchanged input SHA256 hashes, and no stored license. The actual license gate remains in free mode. Pro-only operations stay unavailable.

## Run the evidence check

Use macOS with Node 22, Poppler's `pdfinfo` and `pdftotext`, and `/usr/bin/sandbox-exec`. The run used TypeScript 5.9.3, MCP SDK 1.30.0, pdf-lib 1.17.1 and zod 3.25.76 from an existing installation. It didn't install dependencies.

Build the PDF server and its workspace license and timezone dependencies with the repository's existing build process. The exact-commit audit used a first license declaration emit with TypeScript `noCheck` to establish types for the circular dependency, followed by full checked compiles of timezone, license and PDF. The resulting actual modules were executed without runtime changes.

From the repository root, run the evidence script against a fresh directory.

```sh
node docs/evidence/pdf-offline-20261027/proof.mjs . /path/to/fresh-results
```

The runner refuses to reuse an existing results directory. It starts the real server with separate XDG config and data paths, an explicit small environment, and a macOS `(deny network*)` policy. A direct TCP control probe must fail with `EPERM`. It writes the JSON-RPC transcript, server stderr, synthetic inputs, written outputs and a machine-readable result. Its final console line should match `expected-output.json` in value.

## Observed output

| Output | Pages | Expected order or change |
| --- | --- | --- |
| Merge | 4 | A1 A2 B1 B2 |
| Extract | 3 | A2 A1 A1 |
| Split one | 1 | A1 |
| Split two | 1 | A2 |
| Rotate | 2 | A1 A2, page two at 90 degrees |
| Stamp | 2 | A1 A2, PAID on each page |

The stamp is placed at bottom right so independent text extraction can read it as one word. Poppler splits the default diagonal stamp into separate fragments. That caused the first runner assertion to fail before the test used the existing horizontal position; no runtime fix was made.

## What this establishes

These existing free operations can finish through a local MCP transport without account sign-in or network availability in the tested environment. The MIT license and the current commercial feature checks remain intact. This doesn't deliver an unrestricted standalone PDF core or a direct PDF CLI.

The files use standard-font synthetic text. This check doesn't establish OCR, encrypted document support, hostile-input safety, the 30-page limit boundary, concurrency, broad PDF compatibility, adoption or funding. Network denial proves the exercised process couldn't use the network; the check isn't a syscall audit or a full filesystem sandbox. Existing third-party packages were reused rather than freshly reproduced or audited.
