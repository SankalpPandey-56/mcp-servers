# MCP servers by theluckystrike

<!-- gen:badge -->
![License](https://img.shields.io/badge/license-MIT-blue)
![MCP Registry](https://img.shields.io/badge/MCP%20registry-listed-brightgreen)
![Release](https://img.shields.io/badge/release-v0.25.0-informational)
<!-- /gen:badge -->

> **[All 58 servers, one page — what each does, its tools and its price](https://theluckystrike.github.io/mcp/)** &middot; free locally (MIT), one-time licence for the hosted endpoints &middot; [bundle](https://mcp.zovo.one/buy/bundle)

Practical Model Context Protocol servers for people who work inside Claude, Cursor and other MCP clients.
Every server runs locally over stdio, keeps all data on your machine, and has a genuinely useful free tier.
Pro unlocks the limits for a one-time payment: $19 per server or $39 for the bundle, lifetime.

<!-- gen:counts -->
57 servers plus the office-suite aggregator, 46 of them also reachable as a hosted endpoint with no install.
<!-- /gen:counts -->

Try a free task in this browser: [compare supplier statement open items](https://mcp.zovo.one/guides/compare-supplier-statement-ap-open-items-in-claude#supplier-demo), [review duplicate invoice references](https://mcp.zovo.one/guides/check-duplicate-supplier-invoice-references-in-claude#duplicate-demo), or [match an invoice to a PO and receipts](https://mcp.zovo.one/guides/match-supplier-invoice-purchase-order-delivery-note-in-claude#matcher-demo). These examples compute locally and send no field values or diagnostic requests.

For the hosted servers, open [the connection page](https://mcp.zovo.one/mcp/connect), mint a free token and copy the complete URL. A bare endpoint can initialize and list tools but does not authorize tool calls. Local-only products use their extension or source build; [the catalogue](https://mcp.zovo.one) identifies each supported path.

<!-- gen:install -->
![invoice](assets/demo-invoice.gif)

That is the invoice server answering a real prompt: a client, some hours, a VAT rate, and a numbered PDF at the end.
The table links the demonstrations that are available; some are labeled evidence diagrams rather than client captures.

**Choose the install path supported by your server.**

1. **Claude Desktop bundle.** Choose the server in the [download catalog](https://mcp.zovo.one/downloads), download its versioned `.mcpb` and open it.
2. **Hosted, for 46 servers.** Open [mcp.zovo.one/mcp/connect](https://mcp.zovo.one/mcp/connect), mint a free token and copy the ready URL for your server. That URL includes the token; a bare endpoint does not authorize tool calls. Servers without an endpoint use the bundle or source build.

The npm packages are not published. Use a bundle or the source build below rather than an npm package command.
<!-- /gen:install -->

<!-- gen:table -->
| Server | Demo | What it does | One-click bundle |
|---|---|---|---|
| [mcp-amortization](servers/amortization/README.md) | ![amortization](assets/demo-amortization.gif) | Loan and lease schedules from the terms of the agreement, to the minor unit. | [`amortization.mcpb`](https://mcp.zovo.one/downloads#amortization) |
| [mcp-asset-register](servers/asset-register/README.md) | ![asset-register](assets/demo-asset-register.gif) | A fixed asset register that depreciates on the rates the tax authorities actually publish, with the schedule, the journal and the gain on sale. | [`asset-register.mcpb`](https://mcp.zovo.one/downloads#asset-register) |
| [mcp-backlink-checker](servers/backlink-checker/README.md) | ![backlink-checker](assets/demo-backlink-checker.gif) | Backlink checks from Claude or Cursor: dofollow or nofollow, anchor text, HTTP status and robots guards. | [`backlink-checker.mcpb`](https://mcp.zovo.one/downloads#backlink-checker) |
| [mcp-bank-statement](servers/bank-statement/README.md) | ![bank-statement](assets/demo-bank-statement.gif) | Bank CSV exports categorised, summarised and reconciled with expenses. | [`bank-statement.mcpb`](https://mcp.zovo.one/downloads#bank-statement) |
| [mcp-barcode](servers/barcode/README.md) | ![barcode](assets/demo-barcode.gif) | QR codes and barcodes drawn on your machine, with no upload and no network call. | [`barcode.mcpb`](https://mcp.zovo.one/downloads#barcode) |
| [mcp-bill-of-sale](servers/bill-of-sale/README.md) | ![bill-of-sale](assets/demo-bill-of-sale.gif) | Record a sale of equipment, a vehicle or stock and get a printable bill of sale with signature lines. | [`bill-of-sale.mcpb`](https://mcp.zovo.one/downloads#bill-of-sale) |
| [mcp-billing-docs](servers/billing-docs/README.md) | ![billing-docs](assets/demo-billing-docs.gif) | Credit notes and purchase orders, on the same engine as your invoices. | [`billing-docs.mcpb`](https://mcp.zovo.one/downloads#billing-docs) |
| [mcp-budget](servers/budget/README.md) |  | Monthly budgets you set and check inside the conversation. | [`budget.mcpb`](https://mcp.zovo.one/downloads#budget) |
| [mcp-calendar](servers/calendar/README.md) | ![calendar](assets/demo-calendar.gif) | Read .ics calendars: events, free and busy, conflicts, exports. | [`calendar.mcpb`](https://mcp.zovo.one/downloads#calendar) |
| [mcp-cash-book](servers/cash-book/README.md) | ![cash-book](assets/demo-cash-book.gif) | One double-entry ledger derived from the books you already keep, proved to the minor unit. | [`cash-book.mcpb`](https://mcp.zovo.one/downloads#cash-book) |
| [mcp-catalogue](servers/catalogue/README.md) | ![catalogue](assets/demo-catalogue.gif) | One price list and one rate card, kept where the invoice and the quote can both read them. | [`catalogue.mcpb`](https://mcp.zovo.one/downloads#catalogue) |
| [mcp-change-order](servers/change-order/README.md) | ![change-order](assets/demo-change-order.gif) | Change orders against a quote or a work order, with the running contract value derived from what the client approved. | [`change-order.mcpb`](https://mcp.zovo.one/downloads#change-order) |
| [mcp-checklist](servers/checklist/README.md) | ![checklist](assets/demo-checklist.gif) | Checklists you build once and run many times, and the dated record of each run that somebody signs. | [`checklist.mcpb`](https://mcp.zovo.one/downloads#checklist) |
| [mcp-clauses](servers/clauses/README.md) | ![clauses](assets/demo-clauses.gif) | Reusable contract clauses, searched and assembled into Word. | [`clauses.mcpb`](https://mcp.zovo.one/downloads#clauses) |
| [mcp-credit-note](servers/credit-note/README.md) | ![credit-note](assets/demo-credit-note.gif) | Credit notes against an invoice or standalone: drafts, finalization, rendering and totals, all in integer minor units. | [`credit-note.mcpb`](https://mcp.zovo.one/downloads#credit-note) |
| [mcp-currency](servers/currency/README.md) | ![currency](assets/demo-currency.gif) | ECB reference rates: convert, history, and fx_rates for rebilling. | [`currency.mcpb`](https://mcp.zovo.one/downloads#currency) |
| [mcp-delivery-schedule](servers/delivery-schedule/README.md) | ![delivery-schedule](assets/demo-delivery-schedule.gif) | Dated deliverables against a quote or a work order, and what is late as at any date you name. | [`delivery-schedule.mcpb`](https://mcp.zovo.one/downloads#delivery-schedule) |
| [mcp-deposits](servers/deposits/README.md) | ![deposits](assets/demo-deposits.gif) | Security and retainer deposits, held per client, on the same engine as your invoices. | [`deposits.mcpb`](https://mcp.zovo.one/downloads#deposits) |
| [mcp-docx](servers/docx/README.md) | ![docx](assets/demo-docx.gif) | Real Word documents from chat: proposals, contracts, quotes. | [`docx.mcpb`](https://mcp.zovo.one/downloads#docx) |
| [mcp-dunning-letters](servers/dunning-letters/README.md) | ![dunning-letters](assets/demo-dunning-letters.gif) | Chase overdue invoices on a ladder anchored to the due date: reminder 1, reminder 2, the final notice, with the aging and the day's chase list. | [`dunning-letters.mcpb`](https://mcp.zovo.one/downloads#dunning-letters) |
| [mcp-duplicate-invoice-check](servers/duplicate-invoice-check/README.md) | ![duplicate-invoice-check](assets/demo-duplicate-invoice-check.gif) | Review duplicate supplier invoice candidates in supplied local history. | [`duplicate-invoice-check.mcpb`](https://mcp.zovo.one/downloads#duplicate-invoice-check) |
| [mcp-expense-tracker](servers/expense-tracker/README.md) | ![expense-tracker](assets/demo-expense-tracker.gif) | Receipts, mileage and expenses that turn into invoice lines. | [`expense-tracker.mcpb`](https://mcp.zovo.one/downloads#expense-tracker) |
| [mcp-goods-receipt](servers/goods-receipt/README.md) | ![goods-receipt](assets/demo-goods-receipt.gif) | The receiving record for purchase orders: what arrived, against which line, in what quantity and condition. | [`goods-receipt.mcpb`](https://mcp.zovo.one/downloads#goods-receipt) |
| [mcp-hourly-rate](servers/hourly-rate/README.md) | ![hourly-rate](assets/demo-hourly-rate.gif) | Price your hours from income, expenses, and tax, with what-if scenarios. | [`hourly-rate.mcpb`](https://mcp.zovo.one/downloads#hourly-rate) |
| [mcp-image](servers/image/README.md) | ![image](assets/demo-image.gif) | Resize, convert, compress and watermark images, pure JavaScript. | [`image.mcpb`](https://mcp.zovo.one/downloads#image) |
| [mcp-invoice](servers/invoice/README.md) | ![invoice](assets/demo-invoice.gif) | Numbered invoices with tax lines, rendered to a professional PDF. | [`invoice.mcpb`](https://mcp.zovo.one/downloads#invoice) |
| [mcp-job-card](servers/job-card/README.md) | ![job-card](assets/demo-job-card.gif) | One card per job: hours and materials logged against it, a status machine from open to invoiced, and the printed card for client sign-off. | [`job-card.mcpb`](https://mcp.zovo.one/downloads#job-card) |
| [mcp-kanban](servers/kanban/README.md) | ![kanban](assets/demo-kanban.gif) | A task board per project that hands off to the time tracker. | [`kanban.mcpb`](https://mcp.zovo.one/downloads#kanban) |
| [mcp-leave](servers/leave/README.md) | ![leave](assets/demo-leave.gif) | Employee leave and PTO: balances, approvals, calendars, and who-is-out summaries. | [`leave.mcpb`](https://mcp.zovo.one/downloads#leave) |
| [mcp-loan-calculator](servers/loan-calculator/README.md) |  | Monthly payments and full amortization in one sentence. | [`loan-calculator.mcpb`](https://mcp.zovo.one/downloads#loan-calculator) |
| [mcp-maintenance-log](servers/maintenance-log/README.md) |  | Equipment maintenance log: assets, service entries with costs, and a due report computed from stored dates. | [`maintenance-log.mcpb`](https://mcp.zovo.one/downloads#maintenance-log) |
| [mcp-mileage-log](servers/mileage-log/README.md) |  | Mileage log for deductible driving: trips, effective-dated rates, summaries and CSV export. | [`mileage-log.mcpb`](https://mcp.zovo.one/downloads#mileage-log) |
| [mcp-onboarding](servers/onboarding/README.md) | ![onboarding](assets/demo-onboarding.gif) | New-hire onboarding as role-based task templates, with a dated checklist per hire that HR and the manager both read. | [`onboarding.mcpb`](https://mcp.zovo.one/downloads#onboarding) |
| [mcp-packing-list](servers/packing-list/README.md) | ![packing-list](assets/demo-packing-list.gif) | Packing slips that carry no prices: what is in each carton, what it weighs, and what is still to pack. | [`packing-list.mcpb`](https://mcp.zovo.one/downloads#packing-list) |
| [mcp-payroll](servers/payroll/README.md) |  | Gross-to-net for hourly staff, computed in the conversation. | [`payroll.mcpb`](https://mcp.zovo.one/downloads#payroll) |
| [mcp-pdf](servers/pdf/README.md) | ![pdf](assets/demo-pdf.gif) | Merge, split, stamp and read PDFs, pure JavaScript. | [`pdf.mcpb`](https://mcp.zovo.one/downloads#pdf) |
| [mcp-per-diem](servers/per-diem/README.md) | ![per-diem](assets/demo-per-diem.gif) | Statutory travel allowances on the rate tables the tax authorities publish, and the trips you priced with them. | [`per-diem.mcpb`](https://mcp.zovo.one/downloads#per-diem) |
| [mcp-petty-cash](servers/petty-cash/README.md) | ![petty-cash](assets/demo-petty-cash.gif) | A petty cash float on the imprest system, reconciled to the minor unit. | [`petty-cash.mcpb`](https://mcp.zovo.one/downloads#petty-cash) |
| [mcp-pomodoro](servers/pomodoro/README.md) |  | Focus blocks planned in the chat you are already in. | [`pomodoro.mcpb`](https://mcp.zovo.one/downloads#pomodoro) |
| [mcp-price-tracker](servers/price-tracker/README.md) | ![price-tracker](assets/demo-price-tracker.gif) | Check and watch product prices on ordinary shop pages. | [`price-tracker.mcpb`](https://mcp.zovo.one/downloads#price-tracker) |
| [mcp-purchase-requisition](servers/purchase-requisition/README.md) | ![purchase-requisition](assets/demo-purchase-requisition.gif) | Purchase requisitions you build once and approve per order, with the signed record of each approval. | [`purchase-requisition.mcpb`](https://mcp.zovo.one/downloads#purchase-requisition) |
| [mcp-quotes](servers/quotes/README.md) | ![quotes](assets/demo-quotes.gif) | Priced, VAT-correct quotes from chat, and the yes turns into an invoice. | [`quotes.mcpb`](https://mcp.zovo.one/downloads#quotes) |
| [mcp-receipts](servers/receipts/README.md) |  | Turn receipt lines into an itemized, taxed total. | [`receipts.mcpb`](https://mcp.zovo.one/downloads#receipts) |
| [mcp-recurring](servers/recurring/README.md) | ![recurring](assets/demo-recurring.gif) | Scheduled invoices, generated into your invoice book with PDFs. | [`recurring.mcpb`](https://mcp.zovo.one/downloads#recurring) |
| [mcp-resume](servers/resume/README.md) | ![resume](assets/demo-resume.gif) | Resumes and cover letters as Word files from one profile, never invented. | [`resume.mcpb`](https://mcp.zovo.one/downloads#resume) |
| [mcp-service-agreement](servers/service-agreement/README.md) |  | Service agreements for freelancers: scope, deliverables, rate, termination and liability, rendered for signing. | [`service-agreement.mcpb`](https://mcp.zovo.one/downloads#service-agreement) |
| [mcp-spreadsheet](servers/spreadsheet/README.md) | ![spreadsheet](assets/demo-spreadsheet.gif) | Read, query, edit and convert xlsx and csv files safely. | [`spreadsheet.mcpb`](https://mcp.zovo.one/downloads#spreadsheet) |
| [mcp-statement-of-account](servers/statement-of-account/README.md) | ![statement-of-account](assets/demo-statement-of-account.gif) | The one document that answers what a client actually owes you, aged as at any date, with the chaser drafted. | [`statement-of-account.mcpb`](https://mcp.zovo.one/downloads#statement-of-account) |
| [mcp-stripe-billing](servers/stripe-billing/README.md) |  | Check your Stripe balance and build payment links from chat. | [`stripe-billing.mcpb`](https://mcp.zovo.one/downloads#stripe-billing) |
| [mcp-supplier-list](servers/supplier-list/README.md) |  | A supplier directory that does not rot: contacts, terms, lead times, and when each record was last reviewed. | [`supplier-list.mcpb`](https://mcp.zovo.one/downloads#supplier-list) |
| [mcp-supplier-statement-check](servers/supplier-statement-check/README.md) | ![supplier-statement-check](assets/demo-supplier-statement-check.gif) | Compare supplied supplier statement and AP ledger open items, with complete exact-key evidence. | [`supplier-statement-check.mcpb`](https://mcp.zovo.one/downloads#supplier-statement-check) |
| [mcp-tax-calc](servers/tax-calc/README.md) |  | 2026 US federal brackets, computed in the conversation. | [`tax-calc.mcpb`](https://mcp.zovo.one/downloads#tax-calc) |
| [mcp-three-way-match](servers/three-way-match/README.md) | ![three-way-match](assets/demo-three-way-match.gif) | Supplier invoice, purchase order and receipt checks by exact SKU. | [`three-way-match.mcpb`](https://mcp.zovo.one/downloads#three-way-match) |
| [mcp-time-tracker](servers/time-tracker/README.md) | ![time-tracker](assets/demo-time-tracker.gif) | Track billable time without leaving the chat. | [`time-tracker.mcpb`](https://mcp.zovo.one/downloads#time-tracker) |
| [mcp-timezone](servers/timezone/README.md) | ![timezone](assets/demo-timezone.gif) | Find meeting slots inside everyone's working hours. | [`timezone.mcpb`](https://mcp.zovo.one/downloads#timezone) |
| [mcp-work-order](servers/work-order/README.md) | ![work-order](assets/demo-work-order.gif) | Job orders for trades and field work, priced the way the invoice will be. | [`work-order.mcpb`](https://mcp.zovo.one/downloads#work-order) |
| [mcp-zip](servers/zip/README.md) | ![zip](assets/demo-zip.gif) | Make a zip, look inside one, and unpack one, entirely on your machine. | [`zip.mcpb`](https://mcp.zovo.one/downloads#zip) |
| [mcp-office-suite](servers/office-suite/README.md) | ![office-suite](assets/demo-office-suite.gif) | One local config entry for invoicing, documents, time tracking and supplier checks. | [`office-suite.mcpb`](https://mcp.zovo.one/downloads#office-suite) |
<!-- /gen:table -->

Or clone and build: `git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers`,
`npm install`, `npm run build`. Each server's README has the full 60-second install with every client config.

Buy Pro: https://mcp.zovo.one  (keys verify offline with Ed25519; no phone-home).

## Hosted endpoints (no install)

<!-- gen:hosted -->
46 servers have hosted endpoints. Open [the connect page](https://mcp.zovo.one/mcp/connect), get a free token and copy the complete URL for the server you need.

The ready URL has the form `https://mcp.zovo.one/mcp/<server>/t/<token>`. If your client supports headers, the bare endpoint also works with `Authorization: Bearer <token>`. The bare URL alone can initialize and list tools but refuses tool calls.

Hosted file tools accept inline data/uploads and return temporary download URLs instead of reading your local disk. Read the server-specific setup guide for supported formats. A local install is the path for files on your machine.

Office Suite, Three-Way Match, Duplicate Invoice Check and Supplier Statement Check are local stdio servers. Do not substitute a hosted URL for their executable. See each server page and the [client setup guides](https://mcp.zovo.one/setup).
<!-- /gen:hosted -->

## Registry names

The MCP registry listing for these servers uses word-rich names instead of the plain directory
name, for example `time-tracker-timesheet-billable-hours` instead of `time-tracker`, or
`office-suite-time-invoice-expense-excel-price` instead of `office-suite`: every extra token is a word the
server's own tool descriptions already use, and registry search matches on whole words, so a name built only
from `time-tracker` was invisible to a search for "timesheet" or "billable hours". The full list, read from
each server's `server.mcpb.json`:

| Server | Registry name |
|---|---|
| time-tracker | `io.github.theluckystrike/time-tracker-timesheet-billable-hours` |
| price-tracker | `io.github.theluckystrike/price-tracker-drop-alert-watch` |
| spreadsheet | `io.github.theluckystrike/excel-spreadsheet-xlsx-csv` |
| invoice | `io.github.theluckystrike/invoice-pdf-billing-generator` |
| expense-tracker | `io.github.theluckystrike/expense-tracker-receipts-mileage` |
| currency | `io.github.theluckystrike/currency-converter-ecb-rates-daily-keyless` |
| docx | `io.github.theluckystrike/docx-document-generator-proposal-contract-markdown` |
| timezone | `io.github.theluckystrike/timezone-world-clock-meeting-slots-overlap-ics` |
| office-suite | `io.github.theluckystrike/office-suite-time-invoice-expense-excel-price` |

The old short names are deprecated on the registry; npm package names, directory names and checkout URLs are
unchanged.

## Why these servers

The median MCP server on the public registry gets installed and never called again. Looking at what actually gets
used, two things separate the servers people keep: a config snippet that works on the first try, and a visible
demo of the tool actually answering a real prompt before anyone installs it. Both of those are cheap to provide and
most servers skip them -- READMEs bury the config three scroll-lengths down, or show no output at all. These servers
were picked because they replace a task people already do in a spreadsheet, a SaaS dashboard or a browser
tab (tracking time, watching a price, editing a sheet, cutting an invoice, logging a receipt, converting a
currency, drafting a Word document, finding a meeting slot across time zones) with one that runs
entirely on-device: no account, no telemetry, no server-side data at rest (the hosted endpoints are the one
exception, and they say plainly what they keep and for how long). office-suite exists because the most-used
server in this category, measured across the registry, is an aggregator: one install beats thirty-one.

## Guides

- [Track time in Claude Code](https://mcp.zovo.one/guides/track-time-in-claude-code)
- [Invoice PDF from chat](https://mcp.zovo.one/guides/invoice-pdf-from-chat)
- [Read Excel in Cursor](https://mcp.zovo.one/guides/read-excel-in-cursor)
- [Price drop alerts with Claude](https://mcp.zovo.one/guides/price-drop-alerts-with-claude)
- [Expense tracking in Claude](https://mcp.zovo.one/guides/expense-tracking-in-claude)
- [MCP server free vs pro](https://mcp.zovo.one/guides/mcp-server-free-vs-pro)
- [Currency conversion, ECB rates, in Claude](https://mcp.zovo.one/guides/currency-conversion-ecb-rates-in-claude)
- [Word documents and proposals from chat](https://mcp.zovo.one/guides/word-documents-proposals-from-chat)
- [Meeting slots across time zones](https://mcp.zovo.one/guides/meeting-slots-across-time-zones)

Also live: [54 client-by-server setup pages](https://mcp.zovo.one/setup) (six clients: Claude Desktop, Claude
Code, Cursor, VS Code, Windsurf, Cline, times every server) and [8 head-to-head compare pages](https://mcp.zovo.one/compare)
against named competitor MCP servers, sourced from each competitor's own README, GitHub metadata or npm/registry
record.

## Validation

Before anything ships: 1,563 unit tests across the servers and the shared license package (protocol smoke
tests over real stdio, plus adversarial cases: bad input, oversized strings, path traversal, concurrent
writers, zero-byte files), a 951-check live validation database run against the built servers and the hosted
worker (`data/validation.json`, run 50), seven rounds of user-value testing through a real MCP client (one
prompt per conversation, not a unit test; round 7 is cross-server, chaining calls across the whole
office-suite bundle), and four rounds of independent Codex model review of the core build plus two more of the
remote hosted worker. Details: [docs/AUDIT.md](docs/AUDIT.md), [docs/CURRENCY_AUDIT.md](docs/CURRENCY_AUDIT.md),
[docs/DOCX_AUDIT.md](docs/DOCX_AUDIT.md), [docs/EXPENSE_AUDIT.md](docs/EXPENSE_AUDIT.md),
[docs/TIMEZONE_AUDIT.md](docs/TIMEZONE_AUDIT.md), [docs/USER_VALUE.md](docs/USER_VALUE.md) through
[docs/USER_VALUE_R7.md](docs/USER_VALUE_R7.md), [docs/CODEX_REVIEW.md](docs/CODEX_REVIEW.md) through
[docs/CODEX_REVIEW_V4.md](docs/CODEX_REVIEW_V4.md), [docs/CODEX_REVIEW_REMOTE.md](docs/CODEX_REVIEW_REMOTE.md),
[docs/CODEX_REVIEW_REMOTE_V2.md](docs/CODEX_REVIEW_REMOTE_V2.md), [docs/REMOTE_RESULT.md](docs/REMOTE_RESULT.md).

## npm status

The MCP packages are not published on npm. Use the versioned [download catalog](https://mcp.zovo.one/downloads), a source build, or the hosted endpoints where available. Earlier npm authentication findings are recorded in [docs/NPM_AUTH_RESULT.md](docs/NPM_AUTH_RESULT.md); an unpublished package command is not an install path.

## Historical access notes

These earlier access findings have not been revalidated in this section. The released bundles, source repositories and hosted setup paths above work without these extra services:

- **npm** -- publish token is dead; needs `npm login --auth-type=web` once, in a browser, from this account.
- **Smithery** -- CLI and REST are otherwise fully scriptable with a bearer key, but getting that key needs one
  browser login: `npx -y @smithery/cli auth login`, then open the printed `smithery.ai/auth/cli?s=<session>`
  URL. `smithery.yaml` is already validated against the CLI schema.

Everything else in this repository -- registry, GitHub, `.mcpb` release, billing, hosted endpoints, guides,
setup pages, compare pages, Docker MCP catalog PR, Cline marketplace issues, mcpservers.org and mcpmarket.com
submissions -- was completed without a human at the keyboard.

Repository layout: `servers/*` one package per server, `packages/mcp-license` shared licensing, `billing/` Cloudflare Worker
that sells keys and serves the marketing site (guides, setup pages, compare pages) through Stripe Checkout,
`remote/` Cloudflare Worker serving the hosted endpoints, `dashboard/` status page, `docs/` runbooks.

Built by theluckystrike. https://github.com/theluckystrike  Support: support@zovo.one
