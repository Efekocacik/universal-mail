import type { imports as TrImports } from "../tr/imports";
import type { EnFragment } from "../types";

/** Package I (Faz 5): CSV/XLSX import page, mapping UI, usage confirmation, results and import errors. */
export const imports = {
  "imports.title": "Import from a list",
  "imports.subtitle": "Add the businesses in your own CSV or Excel (XLSX) list as leads.",
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
