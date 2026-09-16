# Ayers Loan Application — web form

**Live:** https://arthur-ayers.github.io/Ayers_application_form/ayersform/

Moving to **https://aiersq.com.au/ayersform** once the domain's DNS points here.
The bare address redirects to the form, so either form of the link works.

## Repository layout

The form is served from a **subdirectory**, not the repository root, so the published
address ends in `/ayersform`:

```
/                     redirect stub -> ./ayersform/  (relative, so it works
                      under any domain or project path)
/ayersform/     the form: index.html, app.js, styles.css, pdf-export.js,
                      assets/, vendor/
/README.md            this file
/.nojekyll            serve the files as-is, no Jekyll build
```

**Deploying:** the working copy of the form is the `web/` folder on the broker's Mac.
Its contents go to `ayersform/` in this repository — *not* to the root. Copying
them to the root would put the form back at the bare domain and leave a stale copy of
every file behind. `README.md`, `.gitignore` and `.nojekyll` stay at the root.

A `CNAME` file at the root is what holds the custom domain. GitHub writes it when the
domain is set in Settings, so any deploy that mirrors a folder over the repository must
preserve it — deleting it silently drops the custom domain.

> This repository is **public**. It holds the blank form only. Never commit a completed
> application — the exported JSON and PDF contain client personal and financial details.
> Everything typed into the form stays in the browser on the user's own computer; nothing is
> uploaded anywhere.

A browser version of the printed *Ayers Loan Application (version 2026.1)* PDF. Same layout, colours,
logo and wording, with repeatable **property** and **employment** entries.

## Running it

Double-click **`Start Ayers Form.command`** in the folder above this one. It starts a local server
and opens the form; keep the Terminal window it opens while you use the form.

The equivalent by hand:

```bash
python3 -m http.server 8777 --directory web
```

Then open <http://localhost:8777>. Any static host works too — S3, Netlify, an intranet folder —
just upload the `web` folder as-is.

Opening `web/index.html` directly by double-click also works. Running the local server is still
recommended because it matches the hosted setup and avoids browser-specific `file://` restrictions.

## Editing: bump the cache buster

`index.html` loads `styles.css?v=77`, `pdf-export.js?v=80` and `app.js?v=71`. **Increment that number whenever you change
either file.** Browsers cache both aggressively; without it an edit can appear to do nothing, and —
worse — the form can still *print* with the old layout even though the screen looks current. This
has already caused one bad 6-page print of a form that lays out correctly in 3.

To check a print without guessing, render it headlessly and count the pages:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --no-pdf-header-footer --print-to-pdf=check.pdf --virtual-time-budget=4000 http://localhost:8777/
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The form itself: one continuous sheet |
| `styles.css` | All styling, including the A4 print rules |
| `app.js` | Field templates, repeatable rows, autosave |
| `pdf-export.js` | Draws the completed, still-editable PDF from the live page |
| `assets/ayers-logo.svg` | Logo, extracted as vector from the original PDF |
| `vendor/pdf-lib.min.js` | PDF library, vendored so nothing loads from the internet |

Repeated and per-applicant fields are generated from the lists at the top of `app.js`
(`GENERAL_EXPENSES`, `ASSETS_LEFT`, `CITIZENSHIP`, …). To add or rename a field, edit the list —
the markup follows automatically.

## What changed from the PDF

- **Properties** — was a fixed 5-row table. Now starts at 3 rows with **+ Add property**; rows can
  be removed. No upper limit.
- **Employment** — was one current plus one previous job per applicant. Now a repeatable list per
  applicant via a single **+ Add job** button. Each entry carries its own status, employer, job
  title, address, contact number and dates.
  - Whether an entry is current is controlled by the **Current job** tick on the card, not by which
    button added it. New entries start as previous employment; tick the box for any still held.
  - An applicant can have **more than one current job**. Entries are titled *Current Employment
    1, 2, …* and *Previous Employment 1, 2, …*, counted separately, and ticking or un-ticking moves
    a card into the right group and relabels everything automatically. The entered details always
    stay with their own card.
  - Current jobs are shown with an orange marker and hide the *End Date* field, since there isn't one.
- **Investment property expenses** (page 3) — was a fixed 4 rows. Now repeatable to match however
  many properties the applicant has.
- **Income** — was a single Base / Overtime / Commission / Others row per applicant. Now **one income
  line per job**, added and removed automatically with the employment entries and labelled with the
  job title. Removing a job removes its income line specifically, so the remaining figures stay with
  their own jobs.
- **People** — was two fixed applicant columns. Now *Personal Details 1, 2, 3 …* via
  **+ Add person**, each marked **Applicant** or **Guarantor**. Superannuation rows follow
  the people automatically and are labelled with their names. **Employment Details N** and
  **Income Details N** are generated per person and stay numbered with them, so a third
  applicant or guarantor gets their own employment and income — they used to be missing,
  which meant a guarantor's job and income could not be recorded at all.
- **Assets and liabilities** — motor vehicles, savings, credit cards and car loans start as a
  single row with a **+** instead of a fixed two or four. *Others (please specify)* became
  **Buy Now Pay Later** with a Bank/Provider field. Each credit card and car loan has an
  **Owner** dropdown.
- **Property table** — gained **Remaining Loan Term** and a **To Be Refinanced** tick. The
  address cell wraps and grows so a long address stays visible. *Owner (%)* became an
  **Owner** dropdown.
- **Owner dropdowns** (properties, credit cards, car loans, living expenses) list
  *Applicant 1*, *Applicant 2*, … — one per Personal Details entry — then *Both*. Removing
  a person clears any choice pointing at them and moves later people's choices up one,
  matching how Personal Details renumber.
- **Loan amount** — the PDF never asked how much was being applied for. Added **Loan Amount
  Required**, **Borrower (If Company or Trust)** and **Security / Property Address**.
- **Employment** — added **Home Duties** to the status options.
- **Loan Purpose** — was two groups of tick boxes. Now reads as a sequence:
  **Purpose** (Purchase, Construction, Bridging, Refinance, Top-Up, Pre-Approval)
  → **Usage** (Owner-Occupied, Investment, Business / Commercial, SMSF) → a
  **First Home Guarantee Scheme** tick. Purpose (`purpose_*`) and Usage (`usage_*`) are
  both tick boxes, since a loan can have several of each. The scheme tick stays locked
  until *Purchase* or *Pre-Approval* is ticked **and** *Owner-Occupied* is ticked — a
  pre-approval counts because it is a purchase that has not
  happened yet. Making the loan ineligible also clears the tick, so an application can
  never claim a scheme it does not qualify for. A draft saved under any earlier version
  — the single Purpose or Usage dropdown, or the *Build* / *Renovate* wording — carries
  its choice across on restore.
- **Living expenses** — repeatable with **+ Add living expenses**, for applicants who
  declare their expenses separately. Each block has a **Living Expenses For** owner
  dropdown and its own totals. Block 1 keeps the original field names; later blocks
  prefix theirs `le2_`, `le3_`, …
- **Continuous form** — the three paper sheets are one scrolling page; it is paginated only
  when exported or printed.
- **Totals** calculate as figures are typed — per job, per applicant, and for living
  expenses — and stay editable. A self-employed applicant's earnings sit on the employment
  card rather than in the Base/Overtime columns; the most recent financial year is counted
  in the income total, the prior year is not.
- Added an "If yes, please provide details" box under the significant-change question. The
  paper declaration's signing line and Applicant Name field were dropped — this is a web form.

## Using it

The form is one continuous page — it is not split into sheets on screen.

| Control | What it does |
| --- | --- |
| **Complete Form** (end of the form) | Builds the completed PDF and downloads it |
| **Reset** (top of the form) | Clears everything to start a new application |

It autosaves as you type, so closing the tab by accident does not lose the work;
reopening the page restores it. Nothing is sent anywhere — there is no server side.
An application leaves the browser only when you press **Complete Form**.

Totals calculate as figures are typed, and remain editable rather than locked.
They are recalculated on restore too.

In the downloaded PDF, the **living expense** totals (both column totals and Total
Living Expenses, separately for each block) recalculate when a figure is changed, through form scripts built into
the file. That works in **Adobe Acrobat / Reader** and Chrome's PDF viewer. **macOS
Preview does not run form scripts**, so there the totals stay as they were at download
and an amended figure needs its total corrected by hand. Income totals in the PDF do
not recalculate in any viewer.

## The PDF

**Complete Form** walks the rendered page and redraws it into the PDF as vector —
real text, rectangles and rules — then places an AcroForm field over every input.
So the download is the web form itself, and it can still be typed into afterwards
in Preview, Acrobat or Adobe Reader.

> Safari's built-in PDF viewer and Quick Look show PDFs **read-only**. Open the
> downloaded file in Preview or Acrobat to fill it in. That is an Apple limitation
> and applies to any fillable PDF.

Three things are worth knowing before editing `pdf-export.js`:

- **It measures the on-screen layout**, then scales it with a single factor
  (A4 content width ÷ sheet content width). One uniform scale is what keeps every
  font size and gap in the same proportion as the browser shows. An earlier version
  measured the compacted *print* layout instead, which is why the exported spacing
  and type did not match the screen.
- **Page count is not fixed.** The document runs to as many A4 pages as the content
  needs, breaking between elements so a field or table row is never cut in half.
- **Editable values use fixed, viewer-safe sizes.** Single-line widgets are vertically constrained
  to keep ordinary entries clear and consistent. Property addresses use the property-table
  size of 7 pt in a compact 23%-wide table cell. Repeated whitespace is normalized and
  controlled line breaks are calculated at that size. The sizes
  are preserved when fields are edited in PDF software that respects the field font setting.
- **Dropdowns remain dropdowns in the PDF.** Their option lists are copied from the web
  form. Every main-form input and dropdown uses 8 pt. Every property-table field,
  including its address and dropdown, uses 7 pt. The same size is written to both the
  parent field and each widget. Preview reads the widget
  value when it resaves a form; without that second
  `/DA` it substitutes Helvetica 12 pt.

Two traps that produced real bugs, in case they reappear:

- Text is positioned from each rendered line's own rectangle, not its element box.
  Using the element box clipped tick labels (the checkbox painted over the start of
  the word) and ran `<br>` lines together.
- Elements hidden by `clip: rect(0,0,0,0)` — the screen-reader-only column labels —
  must be skipped explicitly. They are not `display: none`, so they were being drawn
  on top of the visible headings.

Anything marked `.no-print` is taken out of the flow while measuring, so the
**+ Add** buttons leave no gap behind.

## Printing instead

⌘P still prints the page directly if a flat, non-editable copy is wanted.

A standard application prints as **three A4 pages**, one per section. Adding jobs or properties
grows the middle section onto further A4 pages rather than distorting the layout:

Page counts below are measured from real Chrome print-to-PDF output, not estimated:

| Application | Pages |
| --- | --- |
| 1 job, 3 properties | 3 |
| 5 jobs, 6 properties, 4 investment expenses | 4 |

**Safari matters here.** The form is used in Safari as well as Chrome, and the two engines measure
text slightly differently, so the print layout must not depend on fitting a page exactly. Two rules
follow from that:

- **No `zoom` in print.** WebKit scales zoomed content when printing but does not reliably recompute
  page breaks from the scaled size — the classic "prints fine in Chrome, breaks in Safari" fault.
  Headroom is taken out of the layout itself, which every engine measures the same way.
- **No inline `style="margin-…"` on layout blocks.** An inline style beats the print stylesheet, so
  those spacings silently stay at their screen values and quietly eat the headroom. Spacing helpers
  (`.section-gap`, `.subhead.spaced-sm`, `.question`, `.field-gap`) exist as classes for this reason.

Each section currently leaves this much of an A4 page empty — the safety margin that absorbs
engine differences. Keep it near 8%; if an edit pushes a section under about 4%, it will start
spilling a near-empty page in some browser:

| Section | Headroom |
| --- | --- |
| Page 1 — Loan Purpose & Personal Details | 7.9% |
| Page 2 — Employment, Income, Assets | 8.8% |
| Page 3 — Living Expenses | 43.5% |

Three further things make the pagination work:

1. **Margins live on `@page`, not on `.sheet`.** Sheet padding is applied once at the top of the
   box, so a section running onto a second sheet of paper would start hard against the paper edge.
   `@page { margin: 10mm 11mm 8mm }` gives *every* physical page its own margins.
2. **Print styles are compacted** to roughly the density of the original printed form — a section
   would otherwise be ~25% too tall and spill a near-empty second page.
3. **Print styles are structural, not scaled.** Space was found by pairing fields onto shared rows
   (Country + Date moved in; Commencement + End + Contact) rather than by shrinking the page, so the
   saving is identical in every browser.

Records also carry `break-inside: avoid`, headings `break-after: avoid`, and the property table
repeats its header row when it runs on.

Field `name` attributes are stable and predictable, so wiring this to a backend later is a matter of
POSTing the form. Repeated entries are numbered from 1:

```
loan_amount, loan_term_years           # what's being applied for
a1_given_names, a2_surname, …          # applicant 1 / applicant 2
a1_emp_1_employer_name, a1_emp_2_…     # applicant 1's jobs, in display order
a1_emp_1_is_current                    # true = a current job, absent = previous
property_1_address, property_2_…       # property rows
investment_property_1_expense          # page 3 expense rows
```

Employment entries are numbered by position, not by current/previous — read `*_is_current` to tell
them apart. Renumbering happens automatically when a row is removed or reordered, so there are never
gaps, and values always stay with their own entry.
