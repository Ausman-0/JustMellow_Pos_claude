const BOM = '\uFEFF'; // lets Excel detect UTF-8 (Thai)

function cell(v) {
  if (v == null) return '';
  let s = String(v);
  const numeric = /^-?\d+(\.\d+)?$/.test(s);
  // Defuse spreadsheet formula injection (e.g. a product named "=1+1")
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(headers, rows) {
  return BOM + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
