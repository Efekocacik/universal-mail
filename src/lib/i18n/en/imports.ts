import type { imports as TrImports } from "../tr/imports";
import type { EnFragment } from "../types";

/** Package I (Faz 5): CSV/XLSX import page, mapping UI, usage confirmation, results and import errors. */
export const imports = {
  "imports.title": "Import from a list",
  "imports.subtitle": "Add the businesses in your own CSV or Excel (XLSX) list as leads.",
  "imports.file.title": "1. File",
  "imports.file.label": "CSV or XLSX file",
  "imports.file.hint":
    "Up to 5 MB and 5,000 rows. The first row must contain the column headings. Only the first sheet of an Excel file is read.",
  "imports.file.reading": "Reading the file…",
  "imports.file.summary": "{name} · {format} · Rows: {rows} · Columns: {cols}",
  "imports.warning.encoding_fallback":
    "The file is not UTF-8, so it was read as Windows-1252. Check accented characters in the preview.",
  "imports.warning.columns_truncated":
    "The file has more than 200 columns; only the first 200 were read.",
  "imports.warning.extra_cells":
    "Some rows have more cells than there are headings; the extra cells were ignored.",
  "imports.warning.cells_truncated": "Very long cells were cut at 2,000 characters.",
  "imports.warning.duplicate_headers": "Several columns have the same heading; check the mapping.",
  "imports.map.title": "2. Match the columns",
  "imports.map.desc":
    "Choose the file column for each field. We suggested them from the headings; only the business name is required.",
  "imports.field.name": "Business name",
  "imports.field.country": "Country",
  "imports.field.city": "City",
  "imports.field.website": "Website",
  "imports.field.email": "Email",
  "imports.field.category": "Category",
  "imports.field.notes": "Notes",
  "imports.map.none": "Don't use",
  "imports.map.column": "Column {n}",
  "imports.map.required": "required",
  "imports.map.taken":
    "This column is also chosen for another field. Each column can be matched to one field only.",
  "imports.preview.title": "Preview: the first rows of the file",
  "imports.preview.row": "Row",
  "imports.preview.more": "The preview shows the first 20 rows; the import covers every row.",
  "imports.details.title": "3. Defaults and source",
  "imports.defaultCountry": "Default country",
  "imports.defaultCountry.hint": "Used for rows whose country cell is empty.",
  "imports.defaultCountry.none": "Not set",
  "imports.defaultCategory": "Default category",
  "imports.defaultCategory.hint": "Used for rows whose category cell is empty or not recognised.",
  "imports.defaultCategory.none": "No category",
  "imports.sourceNote": "Where did this list come from?",
  "imports.sourceNote.placeholder": "For example: 2026 trade fair exhibitor list",
  "imports.sourceNote.hint":
    "Stored with the import record, so you can show where the data came from later.",
  "imports.ack": "I have the right to use this list and I have stated its source.",
  "imports.ack.hint":
    "Personal email addresses are added too; whether they can be emailed is checked against country rules before sending.",
  "imports.missing.name": "Choose the business name column.",
  "imports.missing.country": "Choose the country column or set a default country.",
  "imports.missing.taken": "The same column is chosen for more than one field.",
  "imports.missing.note": "Describe where the list came from (at least 3 characters).",
  "imports.missing.ack": "Tick the confirmation box before importing.",
  "imports.check": "Check",
  "imports.check.hint": "Shows how many rows would be added, without saving anything.",
  "imports.check.result":
    "Check result: to add {created} · duplicates {duplicates} · invalid {invalid}",
  "imports.run": "Import",
  "imports.result.title": "Import complete",
  "imports.result.created": "Added",
  "imports.result.duplicates": "Duplicates (skipped)",
  "imports.result.invalid": "Invalid (skipped)",
  "imports.result.noneCreated":
    "No new businesses were added: every row was a duplicate or invalid.",
  "imports.result.explore": "Show in Explore",
  "imports.result.again": "Import another file",
  "imports.result.download": "Download skipped rows (CSV)",
  "imports.result.truncated": "The list shows the first 200 rows; the counts are complete.",
  "imports.report.title": "Skipped rows",
  "imports.report.row": "Row",
  "imports.report.kind": "Type",
  "imports.report.reason": "Reason",
  "imports.report.kind.duplicate": "Duplicate",
  "imports.report.kind.invalid": "Invalid",
  "imports.report.filename": "import-report",
  "imports.reason.same_website": "A business with the same website already exists",
  "imports.reason.same_email": "The same email address already exists",
  "imports.reason.same_name_city": "A business with the same name and city already exists",
  "imports.reason.in_file": "Repeats an earlier row in the file",
  "imports.reason.no_name": "Business name is empty",
  "imports.reason.no_country": "Country is empty and no default country is set",
  "imports.reason.bad_country":
    "Country not recognised (European countries and Türkiye are supported)",
  "imports.reason.bad_website": "Website is not a valid http(s) address",
  "imports.reason.bad_email": "Email address is not valid",
  "imports.history.title": "Previous imports",
  "imports.history.empty": "No imports yet. Your first list will appear here.",
  "imports.history.counts": "Added {created} · duplicates {duplicates} · invalid {invalid}",
  "imports.history.active": "In the list: {active}/{created}",
  "imports.history.undo": "Undo",
  "imports.history.restore": "Restore",
  "imports.undo.title": "Undo this import?",
  "imports.undo.body":
    "The businesses added by this import ({n}) are removed from Explore and moved to the archive. Nothing is deleted permanently, and you can restore them at any time. Businesses in an active campaign are not removed.",
  "imports.undo.confirm": "Remove from list",
  "imports.undo.done": "Removed from the list: {changed}",
  "imports.undo.skipped": "Kept because they are in an active campaign: {skipped}",
  "imports.restore.done": "Restored: {changed}",
  "apiError.IMPORT_TOO_LARGE":
    "The file is larger than 5 MB. Split the list and upload it in parts.",
  "apiError.IMPORT_UNSUPPORTED": "This file type is not supported. Choose a CSV or XLSX file.",
  "apiError.IMPORT_PARSE":
    "The file could not be read. It may be damaged, encrypted or in another format; save it as CSV and try again.",
  "apiError.IMPORT_EMPTY": "The file has no rows to import.",
  "apiError.IMPORT_TOO_MANY_ROWS":
    "The file has more than 5,000 rows. Split the list and upload it in parts.",
  "apiError.IMPORT_MAPPING":
    "Choose the business name column; if there is no country column, set a default country.",
  "apiError.IMPORT_ACK_REQUIRED":
    "Confirm that you have the right to use this list and state where it came from.",
} as const satisfies EnFragment<typeof TrImports>;
