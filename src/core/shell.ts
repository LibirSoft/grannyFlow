export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/** Writes text that ends in a newline to path through a quoted heredoc. The script ends in a newline so a wrapper can follow it. */
export function heredocWriteScript(path: string, text: string): string {
  let end = 'GRANNY_REPORT_END'
  while (text.includes(end)) end += '_'
  return `mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf('/')) || '/')} && cat > ${shellQuote(path)} <<'${end}'\n${text}${end}\n`
}
