# Home Finance MVP

A private-by-design household finance prototype. No bank connections, no credentials, no money movement — see `Home_Finance_Project_Brief.pdf` for the full product vision and phased roadmap this build follows.

## Current scope

- Data stored in browser localStorage.
- Manual transaction entry.
- PDF upload and in-browser text extraction (PDF.js).
- Conservative candidate transaction extraction.
- Rule-based categorization **and** type classification (Expense / Income / Transfer / Debt Payment), so a debt payment or an internal transfer is never double-counted as a fresh expense.
- **Statement-aware PDF parsing**: text fragments are grouped back into table rows by their position on the page (not just flattened into one string), and Capital One credit card statements and Capital One 360 checking/savings statements are recognized specifically — their "Payments" vs "Transactions" sections, and "Debit"/"Credit" columns, drive the type suggestion. Anything else falls back to a lower-confidence generic date+amount scan so imports never silently return zero results.
- **Review workflow**: anything extracted from a PDF lands in Review as `status: "extracted"`, never directly in Transactions. The user edits, approves, or ignores each line before it becomes `status: "confirmed"`.
- **Basic duplicate detection**: flags an exact date+amount+description match against confirmed transactions, and — for Debt Payment / Transfer only — a looser same-date-and-amount match, since the same payment often appears on both the card statement and the bank statement with different wording (e.g. "AUTOPAY PYMT" vs "CRCARDPMT").
- Documents view shows confirmed vs. still-pending counts per source file, computed live from transactions/review state rather than a static snapshot — traceability back to the source document.
- Dashboard, transactions, review, bills, budgets, debts, documents sections.

## Run

```bash
python -m http.server 8000
```

Then open http://localhost:8000

## Where this sits in the brief's phases

- **Phase 1 (base):** done — transactions, categories, bills, budgets, debts, documents.
- **Phase 2 (smart import):** in progress — PDF parsing (with a Capital One-specific parser for credit card and 360 checking/savings layouts), review workflow, and basic duplicate detection now exist. Still missing: parsers for other banks' layouts, OCR for scanned PDFs, and history-based or AI-assisted categorization (currently rules-only).
- **Phase 3 (intelligence):** not started — recurring bill detection, spending trends, anomaly detection, forecasting, smart alerts, weekly review.
- **Phase 4 (security/production):** not started — authentication, encrypted storage, backups, audit logs. Not needed for a local-only prototype, but required before this touches real infrastructure.

## Important limitations

- Only Capital One credit card and 360 checking/savings statement layouts have a dedicated parser today. Other banks fall back to a generic date+amount scanner tagged with low confidence — expect to correct more in Review for those.
- Scanned PDFs with no selectable text won't extract anything (no OCR yet).
- Duplicate detection is a heuristic, not true account reconciliation: it won't catch every rewording, and its loose match for Debt Payment/Transfer (same date + amount, any description) could rarely coincide by chance for two unrelated payments — always glance at what it flagged before approving.
- Debt Payment transactions are tracked and totaled but not yet linked to a specific debt balance — the Debts section still requires manual balance updates.
- If you import both a credit card statement and the checking/savings statement that paid it, the same payment will appear on both — approve it from one source and ignore (or ignore all) the matching side to avoid double-counting toward Debt Payment totals.
- Extracted data should always be treated as a suggestion. Amounts, dates, and categories should be verified by the user in Review before being relied on for budgeting or debt decisions.
