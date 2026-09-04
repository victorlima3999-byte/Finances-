import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const KEY = "home-finance-mvp-v1";

const CATEGORIES = ["Housing","Utilities","Groceries","Restaurants","Transportation","Insurance","Subscriptions","Shopping","Healthcare","Debt Payment","Other"];
const TYPES = ["Expense","Income","Transfer","Debt Payment"];

const defaultState = {
  transactions: [],
  pendingReview: [],
  bills: [],
  budgets: [
    {category:"Groceries", limit:700},
    {category:"Restaurants", limit:300},
    {category:"Shopping", limit:350},
    {category:"Transportation", limit:250}
  ],
  debts: [],
  documents: []
};

let state = loadState();
let currentView = "dashboard";

const app = document.getElementById("app");
const pageTitle = document.getElementById("page-title");
const pageSubtitle = document.getElementById("page-subtitle");
const pdfInput = document.getElementById("pdf-input");

function loadState(){
  try { return {...defaultState, ...JSON.parse(localStorage.getItem(KEY) || "{}")}; }
  catch { return structuredClone(defaultState); }
}
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); render(); }
function saveQuiet(){ localStorage.setItem(KEY, JSON.stringify(state)); }

function money(n){ return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n || 0); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function now(){ return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Categorization + type classification.
// Per the project brief, the system must not treat every movement as an
// "Expense" — a debt payment or a transfer between the user's own accounts
// must not be double-counted alongside the original purchase. Rules-based
// classification is layer 1 of the categorization engine described in the brief;
// history-based learning and AI suggestions are future layers, not built yet.
// ---------------------------------------------------------------------------
function categorize(description){
  const s = description.toLowerCase();
  const rules = [
    ["Groceries", /costco|walmart|kroger|aldi|publix|whole foods|trader joe/],
    ["Restaurants", /restaurant|doordash|ubereats|grubhub|mcdonald|starbucks|chipotle/],
    ["Transportation", /shell|exxon|chevron|bp|uber|lyft|gas/],
    ["Subscriptions", /netflix|spotify|hulu|disney|apple\.com\/bill|amazon prime/],
    ["Utilities", /electric|power|water|internet|verizon|att|t-mobile|comcast/],
    ["Insurance", /insurance|geico|state farm|progressive/],
    ["Housing", /mortgage|rent|hoa/],
    ["Shopping", /amazon|target|best buy|home depot|lowe/],
    ["Healthcare", /pharmacy|cvs|walgreens|hospital|clinic/],
    ["Debt Payment", /credit card payment|loan payment|autopay payment|card payment/]
  ];
  for (const [cat,re] of rules) if(re.test(s)) return cat;
  return "Other";
}

function classify(description){
  const s = description.toLowerCase();
  const category = categorize(description);
  let type = "Expense";
  let confidence = category === "Other" ? 0.4 : 0.75;

  if (category === "Debt Payment") { type = "Debt Payment"; confidence = 0.85; }
  if (/\btransfer\b|zelle|venmo|online xfer|acct xfer|account transfer/.test(s)) {
    type = "Transfer";
    confidence = 0.7;
  }
  return { category, type, confidence };
}

function normDesc(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,24); }

// Basic duplicate check per brief section 11. Two layers:
// 1) Exact-ish match: same date + amount + normalized description.
// 2) Loose match for internal money movements only (Debt Payment / Transfer):
//    same date + amount regardless of wording. This catches the common case
//    where the SAME payment shows up on both a credit card statement
//    ("AUTOPAY PYMT") and a checking statement ("CRCARDPMT") with different
//    text — importing both should not double-count it as two debt payments.
// This is a heuristic, not true account reconciliation (section 22 lists
// that as a future feature) — it flags for review, it never auto-deletes.
function isDuplicate(candidate, list){
  const movementTypes = new Set(["Debt Payment","Transfer"]);
  return list.some(t => {
    if (t.date !== candidate.date) return false;
    if (Math.abs(Number(t.amount) - Number(candidate.amount)) >= 0.01) return false;
    if (normDesc(t.description) === normDesc(candidate.description)) return true;
    return movementTypes.has(t.type) && movementTypes.has(candidate.type);
  });
}

// ---------------------------------------------------------------------------
// Statement-aware line parsing (Capital One credit card + 360 checking/
// savings statement layouts, and a reasonable generalization for similarly
// tabular statements). PDF.js gives text as loose fragments with x/y
// coordinates, not lines — grouping fragments by y position (and ordering by
// x within a row) reconstructs the statement's table structure, which the
// old single-regex-over-flattened-text approach destroyed.
// ---------------------------------------------------------------------------
const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

function parseMonthDayToken(tok, year){
  const m = tok.match(/^([A-Za-z]{3})\.?\s+(\d{1,2})$/);
  if(!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if(!mon) return null;
  return `${year}-${String(mon).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
}
function parseNumericDateToken(tok){
  const m = tok.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if(!m) return null;
  let [,mo,da,yr] = m;
  if(!yr) yr = String(new Date().getFullYear());
  if(yr.length===2) yr = "20"+yr;
  return `${yr}-${mo.padStart(2,"0")}-${da.padStart(2,"0")}`;
}
function parseDateToken(tok, year){ return parseMonthDayToken(tok, year) || parseNumericDateToken(tok); }
function isDateToken(tok, year){ return !!parseDateToken(tok, year); }
function isMoneyToken(tok){ return /^[+-]?\s?\$?\d[\d,]*\.\d{2}$/.test(tok.trim()); }
function parseMoneyToken(tok){
  const t = tok.trim();
  const negative = /^-/.test(t);
  const positive = /^\+/.test(t);
  const value = Number(t.replace(/[^0-9.]/g,""));
  return { value, sign: negative ? -1 : (positive ? 1 : 0) };
}

const SKIP_DESC = /^(opening balance|closing balance|total |totals|fees$|interest charge|annual percentage|available credit|credit limit|minimum payment|new balance|previous balance|other credits$|cash advances$|transactions$|payments$|category|amount|balance$|description|date\b|trans date|post date)/i;

function extractAccountLabel(cols){
  // Matches lines like ["360 Performance Savings", "- 36210637035"]
  if(cols.length===2 && /^-?\s*\d{4,}$/.test(cols[1])) return cols[0];
  return null;
}

function detectStatementType(text){
  const t = text.toLowerCase();
  const isCard = /payment due date/.test(t) && /credit limit/.test(t) && /minimum payment/.test(t);
  const isBank = /opening balance/.test(t) && /closing balance/.test(t);
  if(isCard) return "creditcard";
  if(isBank) return "bank";
  return "generic";
}
function detectYear(text){
  const m = text.match(/\b(20\d{2})\b/);
  return m ? m[1] : String(new Date().getFullYear());
}

// Suggests category/type/confidence for one parsed line, aware of which kind
// of statement and which section of it ("payments" vs "purchases" on a card,
// Debit vs Credit on a bank account) the line came from. Still just a
// suggestion — nothing here becomes a real transaction without Review.
function classifyStatementLine({description, stmtType, currentSection, categoryTag, sign}){
  const base = categorize(description);
  const s = description.toLowerCase();

  if(stmtType === "creditcard"){
    if(currentSection === "payments"){
      if(/reward|cash ?back|credit-|refund/.test(s)) return {category:"Other", type:"Income", confidence:0.55};
      return {category:"Debt Payment", type:"Debt Payment", confidence:0.75};
    }
    return {category: base, type:"Expense", confidence: base==="Other"?0.4:0.75};
  }

  if(stmtType === "bank"){
    if(categoryTag.toLowerCase()==="credit" || sign>0){
      if(/interest/.test(s)) return {category:"Other", type:"Income", confidence:0.7};
      return {category:"Other", type:"Income", confidence:0.5};
    }
    if(/crcardpmt|credit card|card ?pmt/.test(s)) return {category:"Debt Payment", type:"Debt Payment", confidence:0.75};
    if(/withdrawal|transfer|xfer|mobile pmt/.test(s)) return {category:"Other", type:"Transfer", confidence:0.4};
    return {category: base, type:"Expense", confidence: base==="Other"?0.35:0.65};
  }

  return classify(description);
}

// Groups a page's text items into visual rows (by rounded y-position,
// ordered by x within the row) so table columns stay intact.
async function extractLines(pdf){
  const lines = [];
  let fullText = "";
  for(let p=1;p<=pdf.numPages;p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map();
    for(const item of content.items){
      if(!item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if(!rows.has(y)) rows.set(y, []);
      rows.get(y).push({x, str:item.str});
    }
    const ys = [...rows.keys()].sort((a,b)=>b-a);
    for(const y of ys){
      const cols = rows.get(y).sort((a,b)=>a.x-b.x).map(i=>i.str.trim()).filter(Boolean);
      if(cols.length){ lines.push(cols); fullText += cols.join(" ") + "\n"; }
    }
  }
  return { lines, fullText, pageCount: pdf.numPages };
}

function extractCandidates(lines, stmtType, year, sourceName){
  const out = [];
  let currentAccount = "";
  let currentSection = "";

  for(const cols of lines){
    if(!cols.length) continue;
    const joined = cols.join(" ");

    const acct = extractAccountLabel(cols);
    if(acct){ currentAccount = acct; continue; }

    if(/payments,\s*credits and adjustments/i.test(joined)){ currentSection="payments"; continue; }
    if(/:\s*transactions$/i.test(joined) || /^transactions$/i.test(cols[0])){ currentSection="purchases"; continue; }

    if(!isDateToken(cols[0], year)) continue;
    const date = parseDateToken(cols[0], year);

    let idx = 1;
    if(cols.length>idx && isDateToken(cols[idx], year)) idx++; // skip a Post Date column

    const rest = cols.slice(idx);
    if(!rest.length) continue;

    const descRaw = rest[0];
    if(SKIP_DESC.test(descRaw.trim())) continue;

    const moneyIdxs = [];
    rest.forEach((c,i)=>{ if(isMoneyToken(c)) moneyIdxs.push(i); });
    if(!moneyIdxs.length) continue;

    // If two money-looking columns are present, the last one is a running
    // balance, not the transaction amount — drop it.
    const amountIdx = moneyIdxs.length>1 ? moneyIdxs[moneyIdxs.length-2] : moneyIdxs[0];
    const { value, sign } = parseMoneyToken(rest[amountIdx]);
    if(!(value>0 && value<1000000)) continue;

    const descParts = rest.slice(0, amountIdx).filter(p=>!/^(debit|credit)$/i.test(p));
    const description = descParts.join(" ").trim().slice(0,120) || "Imported statement item";
    const categoryTag = rest.find(p=>/^(debit|credit)$/i.test(p)) || "";

    const { category, type, confidence } = classifyStatementLine({ description, stmtType, currentSection, categoryTag, sign });

    out.push({
      id: uid(), date, description, amount: value, category, type,
      account: currentAccount, source: sourceName, status: "extracted",
      confidence, notes: "", created_at: now(), updated_at: now()
    });
  }
  return out;
}

// Last-resort fallback for statements that don't match the tabular layouts
// above (e.g. a bank we haven't seen the format of, or odd PDF export).
// Much less reliable — always tagged with low confidence.
function extractCandidatesGeneric(fullText, sourceName){
  const out = [];
  const re = /(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?).{0,100}?([+-]?\s?\$?[\d,]+\.\d{2})/g;
  let m;
  while((m=re.exec(fullText))){
    const { value } = parseMoneyToken(m[2]);
    const description = m[0].replace(m[1],"").replace(m[2],"").replace(/\$/g,"").trim().slice(0,80) || "Imported statement item";
    if(value>0 && value<100000){
      const { category, type } = classify(description);
      out.push({
        id: uid(), date: parseNumericDateToken(m[1]) || new Date().toISOString().slice(0,10),
        description, amount: value, category, type, account: "",
        source: sourceName, status: "extracted", confidence: 0.3, notes: "",
        created_at: now(), updated_at: now()
      });
    }
    if(out.length>=100) break;
  }
  return out;
}

function render(){
  const titles = {
    dashboard:["Dashboard","Your household financial overview"],
    transactions:["Transactions","Every confirmed transaction, imported or manually entered"],
    review:["Review","Confirm or correct data extracted from imported documents before it counts"],
    bills:["Bills","Recurring obligations and due dates"],
    budgets:["Budgets","Track spending against your household targets"],
    debts:["Debts","Track balances and payments without connecting to lenders"],
    documents:["Documents","Statements and PDFs used as source documents"]
  };
  [pageTitle.textContent,pageSubtitle.textContent] = titles[currentView];
  document.querySelectorAll(".nav").forEach(b=>{
    b.classList.toggle("active",b.dataset.view===currentView);
    if (b.dataset.view === "review") {
      b.innerHTML = state.pendingReview.length
        ? `Review <span class="badge">${state.pendingReview.length}</span>`
        : `Review`;
    }
  });

  if(currentView==="dashboard") renderDashboard();
  if(currentView==="transactions") renderTransactions();
  if(currentView==="review") renderReview();
  if(currentView==="bills") renderBills();
  if(currentView==="budgets") renderBudgets();
  if(currentView==="debts") renderDebts();
  if(currentView==="documents") renderDocuments();
}

// Only transactions of type "Expense" count as spending. Debt Payment and
// Transfer are tracked but intentionally excluded here — see brief section 4
// (a card purchase is the expense; the payment that later clears the card
// balance is not a second expense).
function totalExpenses(){
  return state.transactions.filter(t=>t.type==="Expense").reduce((a,t)=>a+Number(t.amount),0);
}
function totalIncome(){
  return state.transactions.filter(t=>t.type==="Income").reduce((a,t)=>a+Number(t.amount),0);
}
function totalDebtPayments(){
  return state.transactions.filter(t=>t.type==="Debt Payment").reduce((a,t)=>a+Number(t.amount),0);
}

function renderDashboard(){
  const expenses = totalExpenses(), income = totalIncome();
  const upcoming = state.bills.filter(b=>b.status!=="Paid").reduce((a,b)=>a+Number(b.amount),0);
  const debt = state.debts.reduce((a,d)=>a+Number(d.balance),0);
  const pendingCount = state.pendingReview.length;

  const banner = pendingCount ? `
    <div class="banner">
      <span>${pendingCount} transaction${pendingCount>1?"s":""} from imported statements ${pendingCount>1?"are":"is"} waiting for review. Nothing from a PDF import counts until you confirm it.</span>
      <button class="primary small" id="goto-review">Review now</button>
    </div>` : "";

  app.innerHTML = `
    ${banner}
    <div class="cards">
      <div class="card"><div class="label">Income</div><div class="value">${money(income)}</div><div class="muted">Confirmed transactions</div></div>
      <div class="card"><div class="label">Expenses</div><div class="value">${money(expenses)}</div><div class="muted">${state.transactions.filter(t=>t.type==="Expense").length} transactions</div></div>
      <div class="card"><div class="label">Upcoming bills</div><div class="value">${money(upcoming)}</div><div class="muted">${state.bills.filter(b=>b.status!=="Paid").length} pending</div></div>
      <div class="card"><div class="label">Debt balance</div><div class="value">${money(debt)}</div><div class="muted">${state.debts.length} debt accounts</div></div>
    </div>
    <div class="two-col">
      <div class="section"><h2>Recent transactions</h2>${recentTable()}</div>
      <div class="section"><h2>Budget status</h2>${budgetSummary()}</div>
    </div>
    <div class="section"><h2>How import works</h2>
      <p class="muted">Uploading a statement never writes directly to your records. It extracts candidate transactions, suggests a category and type, flags likely duplicates against what you've already confirmed, and puts everything in Review. Nothing becomes a real transaction until you approve it there.</p>
    </div>`;

  document.getElementById("goto-review")?.addEventListener("click",()=>{currentView="review";render();});
}

function recentTable(){
  const rows = [...state.transactions].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8);
  if(!rows.length) return `<div class="empty">No transactions yet.</div>`;
  return `<table class="table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th></tr></thead><tbody>
    ${rows.map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.description)}</td><td><span class="pill">${esc(t.category)}</span></td><td>${t.type==="Expense"?"-":""}${money(t.amount)}</td></tr>`).join("")}</tbody></table>`;
}

function budgetSummary(){
  if(!state.budgets.length) return `<div class="empty">No budgets set.</div>`;
  return state.budgets.map(b=>{
    const spent = state.transactions.filter(t=>t.type==="Expense"&&t.category===b.category).reduce((a,t)=>a+Number(t.amount),0);
    const pct = Math.min(100,Math.round(spent/b.limit*100));
    return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(b.category)}</span><strong>${money(spent)} / ${money(b.limit)}</strong></div>
      <div style="margin-top:7px;height:8px;background:#edf0f3;border-radius:999px"><div style="height:8px;width:${pct}%;background:#111827;border-radius:999px"></div></div></div>`
  }).join("");
}

function renderTransactions(){
  const rows = state.transactions;
  app.innerHTML = `<div class="section">
    <h2>Transactions</h2>
    ${rows.length ? `<table class="table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Type</th><th>Amount</th><th>Source</th><th></th></tr></thead><tbody>
    ${rows.map((t,i)=>`<tr><td>${esc(t.date)}</td><td>${esc(t.description)}</td><td><span class="pill">${esc(t.category)}</span></td><td>${esc(t.type)}</td><td>${t.type==="Expense"?"-":""}${money(t.amount)}</td><td class="muted">${esc(t.source||"manual")}</td><td><button class="icon" data-delete-tx="${i}">×</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No transactions yet. Use “+ Add transaction” or import a statement.</div>`}
  </div>`;
  app.querySelectorAll("[data-delete-tx]").forEach(b=>b.onclick=()=>{state.transactions.splice(Number(b.dataset.deleteTx),1);save()});
}

// ---------------------------------------------------------------------------
// Review workflow (brief section 10 + section 24: extracted data is never
// treated as final; the user must approve, correct, or ignore each item).
// ---------------------------------------------------------------------------
function renderReview(){
  const items = state.pendingReview;
  app.innerHTML = `<div class="section">
    <h2>Review imported transactions</h2>
    <p class="muted">These came from a PDF import and are not part of your records yet. Edit anything that looks wrong, then approve or ignore each line. Items flagged as a possible duplicate match a transaction you've already confirmed by date, amount, and description.</p>
    ${items.length ? `
      <div class="review-list">${items.map((c,i)=>reviewRow(c,i)).join("")}</div>
      <div class="review-bulk">
        <button class="primary" id="approve-all">Approve all non-duplicates</button>
        <button class="secondary" id="ignore-all">Ignore all</button>
      </div>
    ` : `<div class="empty">Nothing waiting for review.</div>`}
  </div>`;

  app.querySelectorAll("[data-field]").forEach(el=>{
    el.onchange = () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      state.pendingReview[i][field] = field === "amount" ? Number(el.value) : el.value;
      state.pendingReview[i].duplicate = isDuplicate(state.pendingReview[i],
        state.transactions.concat(state.pendingReview.filter((_,j)=>j!==i)));
      saveQuiet();
      renderReview();
    };
  });

  app.querySelectorAll("[data-approve]").forEach(b=>b.onclick=()=>approveCandidate(Number(b.dataset.approve)));
  app.querySelectorAll("[data-ignore]").forEach(b=>b.onclick=()=>{
    state.pendingReview.splice(Number(b.dataset.ignore),1);
    save();
  });

  document.getElementById("approve-all")?.addEventListener("click",()=>{
    const keep = [];
    state.pendingReview.forEach(c=>{
      if (c.duplicate) { keep.push(c); return; }
      state.transactions.push(confirmCandidate(c));
    });
    state.pendingReview = keep;
    save();
  });
  document.getElementById("ignore-all")?.addEventListener("click",()=>{
    if(confirm("Ignore all pending review items? This cannot be undone.")){
      state.pendingReview = [];
      save();
    }
  });
}

function reviewRow(c,i){
  return `<div class="review-row${c.duplicate?" is-duplicate":""}">
    <div class="review-fields">
      <input data-field="date" data-i="${i}" type="date" value="${esc(c.date)}">
      <input data-field="description" data-i="${i}" type="text" value="${esc(c.description)}">
      <input data-field="amount" data-i="${i}" type="number" step="0.01" value="${c.amount}">
      <select data-field="category" data-i="${i}">${CATEGORIES.map(cat=>`<option ${cat===c.category?"selected":""}>${cat}</option>`).join("")}</select>
      <select data-field="type" data-i="${i}">${TYPES.map(t=>`<option ${t===c.type?"selected":""}>${t}</option>`).join("")}</select>
    </div>
    <div class="review-meta">
      <span class="muted">From ${esc(c.source)} · suggested confidence ${Math.round(c.confidence*100)}%</span>
      ${c.duplicate?'<span class="pill warn">Possible duplicate</span>':""}
    </div>
    <div class="review-actions">
      <button class="primary small" data-approve="${i}">Approve</button>
      <button class="icon" data-ignore="${i}" title="Ignore">×</button>
    </div>
  </div>`;
}

function confirmCandidate(c){
  return {
    id: c.id || uid(),
    date: c.date, description: c.description, amount: Number(c.amount),
    category: c.category, type: c.type, account: c.account || "",
    source: c.source, status: "confirmed", confidence: c.confidence ?? 1,
    notes: c.notes || "", created_at: c.created_at || now(), updated_at: now()
  };
}
function approveCandidate(i){
  const c = state.pendingReview[i];
  state.transactions.push(confirmCandidate(c));
  state.pendingReview.splice(i,1);
  save();
}

function renderBills(){
  app.innerHTML = `<div class="section">
    <h2>Bills</h2>
    ${state.bills.length ? `<table class="table"><thead><tr><th>Bill</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead><tbody>
    ${state.bills.map(b=>`<tr><td>${esc(b.name)}</td><td>${esc(b.dueDate)}</td><td>${money(b.amount)}</td><td><span class="pill">${esc(b.status)}</span></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No bills yet. Bills will become a dedicated importer in the next iteration.</div>`}
  </div>`;
}

function renderBudgets(){
  app.innerHTML = `<div class="section"><h2>Budgets</h2>${state.budgets.map(b=>{
    const spent=state.transactions.filter(t=>t.category===b.category&&t.type==="Expense").reduce((a,t)=>a+Number(t.amount),0);
    return `<div style="padding:14px 0;border-bottom:1px solid #eef0f3"><strong>${esc(b.category)}</strong><div class="muted">${money(spent)} spent of ${money(b.limit)}</div></div>`
  }).join("")}</div>`;
}

function renderDebts(){
  const paid = totalDebtPayments();
  app.innerHTML = `<div class="section"><h2>Debts</h2>
    ${state.debts.length ? `<table class="table"><thead><tr><th>Debt</th><th>Balance</th><th>APR</th><th>Minimum</th></tr></thead><tbody>${state.debts.map(d=>`<tr><td>${esc(d.name)}</td><td>${money(d.balance)}</td><td>${esc(d.apr||"—")}</td><td>${money(d.minimum||0)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No debts added yet.</div>`}
    <p class="muted" style="margin-top:14px">Confirmed transactions marked as "Debt Payment" total ${money(paid)}. This is shown for context only — payments aren't linked to a specific debt balance yet, so balances above must still be updated manually.</p>
  </div>`;
}

function renderDocuments(){
  app.innerHTML = `<div class="section">
    <h2>Import a statement</h2>
    <div class="upload"><div><strong>PDF statement</strong></div><div class="muted">Text extraction runs in your browser. Nothing is sent to a bank, and nothing is added to your records until you review and approve it.</div><button class="primary" id="pick-pdf">Choose PDF</button></div>
    <div class="file-list">${state.documents.length ? state.documents.map(d=>{
      const confirmed = state.transactions.filter(t=>t.source===d.name).length;
      const pending = state.pendingReview.filter(t=>t.source===d.name).length;
      const typeLabel = {creditcard:"Credit card statement", bank:"Bank statement", generic:"Unrecognized format"}[d.statementType] || "";
      return `<div class="file-row">
        <div><strong>${esc(d.name)}</strong><div class="muted">${d.pages} pages${typeLabel?` · ${typeLabel}`:""} · imported ${new Date(d.importedAt).toLocaleDateString()}</div></div>
        <div class="muted">${confirmed} confirmed${pending?` · ${pending} pending review`:""}</div>
      </div>`;
    }).join("") : `<div class="empty">No documents imported.</div>`}</div>
  </div>`;
  document.getElementById("pick-pdf").onclick=()=>pdfInput.click();
}

async function importPdf(file){
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data}).promise;
  const { lines, fullText, pageCount } = await extractLines(pdf);

  const stmtType = detectStatementType(fullText);
  const year = detectYear(fullText);

  let candidates = extractCandidates(lines, stmtType, year, file.name);
  let usedFallback = false;
  if(!candidates.length){
    // The tabular parser found nothing recognizable — fall back to the
    // conservative generic scanner rather than importing zero transactions.
    candidates = extractCandidatesGeneric(fullText, file.name);
    usedFallback = true;
  }

  candidates.forEach(c=>{
    c.duplicate = isDuplicate(c, state.transactions.concat(state.pendingReview))
      || candidates.some(x=>x!==c && isDuplicate(c,[x]));
  });

  state.documents.push({name:file.name,pages:pageCount,importedAt:now(),statementType:stmtType});
  state.pendingReview.push(...candidates);
  currentView = "review";
  save();

  const dupCount = candidates.filter(c=>c.duplicate).length;
  const typeNote = usedFallback
    ? " This statement's layout wasn't recognized, so a lower-confidence generic scan was used — double-check these carefully."
    : stmtType === "generic"
      ? " This didn't look like a Capital One credit card or 360 checking/savings statement, so a generic scan was used."
      : "";
  alert(`Imported ${file.name}: ${pageCount} pages, ${candidates.length} candidate transaction(s) found${dupCount?`, ${dupCount} possible duplicate(s) flagged`:""}.${typeNote} Nothing has been added to your records yet — review and approve each item now.`);
}

document.querySelectorAll(".nav").forEach(b=>b.addEventListener("click",()=>{currentView=b.dataset.view;render()}));

const modal = document.getElementById("transaction-modal");
document.getElementById("quick-add").onclick=()=>modal.classList.remove("hidden");
document.getElementById("close-modal").onclick=()=>modal.classList.add("hidden");
document.getElementById("transaction-form").onsubmit=(e)=>{
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  state.transactions.push({
    id: uid(),
    description: fd.get("description"),
    amount: Number(fd.get("amount")),
    date: fd.get("date"),
    category: fd.get("category"),
    type: fd.get("type"),
    account: "",
    source: "manual",
    status: "confirmed",
    confidence: 1,
    notes: "",
    created_at: now(),
    updated_at: now()
  });
  e.currentTarget.reset();
  modal.classList.add("hidden");
  save();
};

pdfInput.onchange=async()=>{ const f=pdfInput.files?.[0]; if(f) try{await importPdf(f)}catch(err){console.error(err);alert("Could not read this PDF. It may be scanned/image-only or use an unsupported structure.")}; pdfInput.value="" };

render();
