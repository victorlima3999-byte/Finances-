# Home Finance MVP

A private-by-design household finance prototype. No bank connections, no credentials, no money movement — see `Home_Finance_Project_Brief.pdf` for the full product vision and phased roadmap this build follows.

## Current scope

- Data stored in browser localStorage.
- Manual transaction entry.
- PDF upload and in-browser text extraction (PDF.js).
- Conservative candidate transaction extraction.
- Rule-based categorization **and** type classification (Expense / Income / Transfer / Debt Payment), so a debt payment or an internal transfer is never double-counted as a fresh expense.
- **Review workflow**: anything extracted from a PDF lands in Review as `status: "extracted"`, never directly in Transactions. The user edits, approves, or ignores each line before it becomes `status: "confirmed"`.
- **Basic duplicate detection**: candidates are flagged when their date, amount, and description match a transaction that's already confirmed (or another candidate in the same batch).
- Documents view shows confirmed vs. still-pending counts per source file, computed live from transactions/review state rather than a static snapshot — traceability back to the source document.
- Dashboard, transactions, review, bills, budgets, debts, documents sections.

## Run

```bash
python -m http.server 8000
```

Then open http://localhost:8000

## Where this sits in the brief's phases

- **Phase 1 (base):** done — transactions, categories, bills, budgets, debts, documents.
- **Phase 2 (smart import):** in progress — PDF parsing, review workflow, and basic duplicate detection now exist. Still missing: statement/bank-specific parsers, OCR for scanned PDFs, and history-based or AI-assisted categorization (currently rules-only).
- **Phase 3 (intelligence):** not started — recurring bill detection, spending trends, anomaly detection, forecasting, smart alerts, weekly review.
- **Phase 4 (security/production):** not started — authentication, encrypted storage, backups, audit logs. Not needed for a local-only prototype, but required before this touches real infrastructure.

## Important limitations

- The PDF parser is still a first prototype — real statements vary widely, and scanned PDFs with no selectable text won't extract anything.
- Duplicate detection is a simple exact-match heuristic, not fuzzy matching across re-imported statements with slightly different formatting.
- Debt Payment transactions are tracked and totaled but not yet linked to a specific debt balance — the Debts section still requires manual balance updates.
- Extracted data should always be treated as a suggestion. Amounts, dates, and categories should be verified by the user in Review before being relied on for budgeting or debt decisions.
