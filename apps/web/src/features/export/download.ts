/** A file name from a document title: the title itself, minus what file systems refuse. */
export function fileName(title: string, extension: string): string {
  const base =
    title
      .replace(/[\\/:*?"<>|]/g, ' ') // reserved on Windows, and / everywhere
      .replace(/\p{Cc}/gu, '') // control characters
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120)
      .trim() || 'Untitled document'
  return `${base}.${extension}`
}

/** Hands a file to the browser to save. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  // Revoked later: some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
